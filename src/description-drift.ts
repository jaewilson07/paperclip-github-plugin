import { createHash } from 'node:crypto';

/** Per-text cap inside a drift comment, so two texts fit under the comment size limit. */
export const DRIFT_COMMENT_TEXT_LIMIT = 8000;

export type DescriptionDriftDecision =
  /** Paperclip already matches the GitHub text. Record the hash, clear any drift. */
  | { action: 'in_sync' }
  /** Nobody edited the Paperclip text since the last write (or there is no baseline yet): overwrite as before. */
  | { action: 'write' }
  /** The Paperclip text was edited. Do not write. `report` is false when this exact pair was already reported. */
  | { action: 'drift'; driftKey: string; report: boolean };

export function hashDescription(text: string | null | undefined): string {
  return createHash('sha256').update((text ?? '').replace(/\r\n?/g, '\n')).digest('hex').slice(0, 32);
}

export function decideDescriptionDrift(params: {
  currentDescription: string | null | undefined;
  nextDescription: string;
  /** Hash of the Paperclip description the plugin last wrote or adopted for this issue. */
  storedHash?: string;
  /** Key of the (Paperclip text, GitHub text) pair a drift comment was last posted for. */
  storedDriftKey?: string;
}): DescriptionDriftDecision {
  const currentHash = hashDescription(params.currentDescription);
  const nextHash = hashDescription(params.nextDescription);
  if (currentHash === nextHash) {
    return { action: 'in_sync' };
  }

  // No stored hash (first sync after upgrade): the current Paperclip text becomes the baseline, not drift.
  if (!params.storedHash || params.storedHash === currentHash) {
    return { action: 'write' };
  }

  const driftKey = `${currentHash}:${nextHash}`;
  return { action: 'drift', driftKey, report: params.storedDriftKey !== driftKey };
}

function fence(text: string): string {
  let ticks = '```';
  while (text.includes(ticks)) {
    ticks += '`';
  }
  return `${ticks}markdown\n${text}\n${ticks}`;
}

function truncateForComment(text: string): { body: string; note: string } {
  if (text.length <= DRIFT_COMMENT_TEXT_LIMIT) {
    return { body: text, note: '' };
  }
  return {
    body: text.slice(0, DRIFT_COMMENT_TEXT_LIMIT),
    note: `\n_Truncated: showing the first ${DRIFT_COMMENT_TEXT_LIMIT} of ${text.length} characters._`
  };
}

export function buildDescriptionDriftComment(params: {
  githubIssueUrl: string;
  paperclipDescription: string | null | undefined;
  githubDescription: string;
}): string {
  const paperclip = truncateForComment(params.paperclipDescription ?? '');
  const github = truncateForComment(params.githubDescription);
  return [
    '## GitHub Sync: description drift',
    '',
    `The description of this issue was edited in Paperclip after the last sync, and it now differs from ${params.githubIssueUrl}. GitHub Sync did **not** overwrite it and will not write to GitHub. Labels and status keep syncing.`,
    '',
    '**Paperclip text (kept):**',
    fence(paperclip.body) + paperclip.note,
    '',
    '**GitHub text (not applied):**',
    fence(github.body) + github.note,
    '',
    'The agent that owns this issue decides how to resolve it:',
    '- Move the extra Paperclip text into a comment, then use **Accept GitHub description** on the issue\'s GitHub tab to resume description sync.',
    '- Or change the GitHub issue body through your own GitHub tools so it matches; sync resumes once the two texts match.',
    '',
    'Durable instructions for linked issues belong in the GitHub body or in comments, not in the Paperclip description.'
  ].join('\n');
}
