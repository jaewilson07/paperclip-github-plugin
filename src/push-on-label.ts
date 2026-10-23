/**
 * Push Paperclip issues that carry the `ready-for-agent` label (ADR-062, DAT-1429).
 *
 * Paperclip emits no issue-updated event, so a scheduled tick looks for labelled issues instead.
 * The module holds only the decision rules and depends on the small `PushOnLabelDeps` seam, so it
 * is tested without the worker. The actual push is `pushIssueToGitHub` (DAT-1428), which is
 * idempotent: a failed push is retried on the next tick and cannot create a duplicate.
 */

export const READY_FOR_AGENT_LABEL = 'ready-for-agent';

/** Issues in these statuses are not pushed; the work is finished or abandoned. */
export const PUSH_ON_LABEL_SKIPPED_STATUSES: readonly string[] = ['done', 'cancelled'];

export interface PushOnLabelIssue {
  id: string;
  identifier?: string | null;
  status?: string | null;
  projectId?: string | null;
  /** Absent when the listing did not include labels; `loadLabels` is then asked. */
  labels?: Array<{ name: string }> | null;
}

export type PushOnLabelOutcome =
  | { issueId: string; result: 'pushed'; number: number; url: string }
  | { issueId: string; result: 'skipped'; reason: 'not_found' | 'no_label' | 'closed' | 'no_project' | 'no_repository' | 'linked' }
  | { issueId: string; result: 'failed'; message: string; reported: boolean };

export interface PushOnLabelDeps {
  /** One page-walk of the company's issues. Labels may be missing. */
  listIssues(): Promise<PushOnLabelIssue[]>;
  getIssue(issueId: string): Promise<PushOnLabelIssue | null>;
  /** Label names of an issue whose listing carried none. */
  loadLabels(issueId: string): Promise<string[]>;
  hasLink(issueId: string): Promise<boolean>;
  projectHasRepository(projectId: string): Promise<boolean>;
  push(issueId: string): Promise<{ number: number; url: string }>;
  /** Last failure message already posted on the ticket, if any. Cleared by `clearFailure`. */
  lastReportedFailure(issueId: string): Promise<string | undefined>;
  reportFailure(issueId: string, message: string): Promise<void>;
  clearFailure(issueId: string): Promise<void>;
}

export function hasReadyLabel(names: Iterable<string>): boolean {
  for (const name of names) {
    if (name.trim().toLowerCase() === READY_FOR_AGENT_LABEL) {
      return true;
    }
  }
  return false;
}

/** Decide and, when everything allows it, push one issue. Never throws for a failed push. */
export async function pushIssueIfReady(deps: PushOnLabelDeps, issue: PushOnLabelIssue): Promise<PushOnLabelOutcome> {
  const issueId = issue.id;
  const names = issue.labels ? issue.labels.map((label) => label.name) : await deps.loadLabels(issueId);
  if (!hasReadyLabel(names)) {
    return { issueId, result: 'skipped', reason: 'no_label' };
  }
  if (issue.status && PUSH_ON_LABEL_SKIPPED_STATUSES.includes(issue.status)) {
    return { issueId, result: 'skipped', reason: 'closed' };
  }
  if (!issue.projectId) {
    return { issueId, result: 'skipped', reason: 'no_project' };
  }
  if (await deps.hasLink(issueId)) {
    return { issueId, result: 'skipped', reason: 'linked' };
  }
  if (!(await deps.projectHasRepository(issue.projectId))) {
    return { issueId, result: 'skipped', reason: 'no_repository' };
  }

  try {
    const pushed = await deps.push(issueId);
    await deps.clearFailure(issueId);
    return { issueId, result: 'pushed', number: pushed.number, url: pushed.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The same failure on every tick would flood the ticket with comments; report it once.
    const reported = (await deps.lastReportedFailure(issueId)) !== message;
    if (reported) {
      await deps.reportFailure(issueId, message);
    }
    return { issueId, result: 'failed', message, reported };
  }
}

export interface PushTickSummary {
  outcomes: PushOnLabelOutcome[];
  pushed: number;
  failed: number;
}

/** The scheduled tick: every labelled, unlinked issue in a project with a repository. */
export async function runPushOnLabelTick(deps: PushOnLabelDeps): Promise<PushTickSummary> {
  const outcomes: PushOnLabelOutcome[] = [];
  for (const issue of await deps.listIssues()) {
    // A listing that carries labels lets unlabelled issues drop out without any further call.
    if (issue.labels && !hasReadyLabel(issue.labels.map((label) => label.name))) {
      continue;
    }
    // One broken issue must not stop the rest of the tick.
    outcomes.push(await pushIssueIfReady(deps, issue));
  }
  return {
    outcomes,
    pushed: outcomes.filter((outcome) => outcome.result === 'pushed').length,
    failed: outcomes.filter((outcome) => outcome.result === 'failed').length
  };
}

/** The "push now" action: same rules as the tick, one issue, no waiting for the next tick. */
export async function pushNow(deps: PushOnLabelDeps, issueId: string): Promise<PushOnLabelOutcome> {
  const issue = await deps.getIssue(issueId);
  if (!issue) {
    return { issueId, result: 'skipped', reason: 'not_found' };
  }
  return pushIssueIfReady(deps, issue);
}
