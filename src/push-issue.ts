/**
 * Push a Paperclip issue to GitHub (ADR-062, DAT-1428).
 *
 * Creates one GitHub issue in the repository of the Paperclip issue's project, writes the
 * Paperclip identifier into its body, and stores the link in the same step. The module only
 * depends on `ForgeLinkStore` and the small `PushIssueDeps` seam, so it is tested without the
 * worker and keeps working when DAT-1427 swaps in the real store.
 */
import type { ForgeLink, ForgeLinkStore } from './forge-link.ts';

export interface PushIssueSource {
  id: string;
  /** Human identifier such as `DAT-1428`. */
  identifier: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
}

export interface PushRepository {
  host: string;
  /** `owner/name`. */
  repository: string;
}

export interface PushedGitHubIssue {
  number: number;
  url: string;
  body?: string | null;
}

export interface PushIssueDeps {
  store: ForgeLinkStore;
  getIssue(issueId: string): Promise<PushIssueSource | null>;
  /**
   * The repository of the issue's project. Must throw `PushIssueRefusedError` when the project
   * has none (or several and `requested` does not pick one).
   */
  resolveRepository(issue: PushIssueSource, requested?: string): Promise<PushRepository>;
  /** Open or closed GitHub issues in the repository whose body carries `marker`. */
  findIssueByMarker(repository: PushRepository, marker: string): Promise<PushedGitHubIssue[]>;
  createIssue(repository: PushRepository, input: { title: string; body: string }): Promise<PushedGitHubIssue>;
}

export interface PushIssueResult {
  /** True when this call created the GitHub issue or the link; false for an existing link. */
  created: boolean;
  link: ForgeLink;
}

/** The push cannot proceed and retrying will not help until someone changes configuration. */
export class PushIssueRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushIssueRefusedError';
  }
}

/** First line of the GitHub issue body. Searched for before creating, so it must stay stable. */
export function buildPushMarker(identifier: string): string {
  return `Paperclip issue: ${identifier}`;
}

export function buildPushIssueBody(issue: PushIssueSource): string {
  const description = issue.description?.trim();
  return [buildPushMarker(issue.identifier), '', description || '_No description._'].join('\n');
}

/** True when `body` has the marker on its own line, so DAT-14 never matches DAT-142. */
export function bodyHasPushMarker(body: string | null | undefined, identifier: string): boolean {
  const marker = buildPushMarker(identifier);
  return (body ?? '').split(/\r?\n/).some((line) => line.trim() === marker);
}

export async function pushIssueToGitHub(
  deps: PushIssueDeps,
  input: { paperclipIssueId: string; repository?: string }
): Promise<PushIssueResult> {
  const issue = await deps.getIssue(input.paperclipIssueId);
  if (!issue) {
    throw new PushIssueRefusedError('Paperclip issue was not found.');
  }
  if (!issue.identifier?.trim()) {
    throw new PushIssueRefusedError('This Paperclip issue has no identifier to write into the GitHub issue.');
  }

  const existing = (await deps.store.list(issue.id)).find((link) => link.forge === 'github' && link.kind === 'issue');
  if (existing) {
    return { created: false, link: existing };
  }

  const repository = await deps.resolveRepository(issue, input.repository);
  // A crash after the GitHub issue was created but before the link was stored leaves an orphan.
  // Reuse it instead of creating a duplicate.
  const orphan = (await deps.findIssueByMarker(repository, buildPushMarker(issue.identifier)))
    .filter((candidate) => bodyHasPushMarker(candidate.body, issue.identifier))
    .sort((a, b) => a.number - b.number)[0];
  const pushed = orphan
    ?? await deps.createIssue(repository, { title: issue.title, body: buildPushIssueBody(issue) });

  const link: ForgeLink = {
    forge: 'github',
    host: repository.host,
    repository: repository.repository,
    number: pushed.number,
    kind: 'issue',
    url: pushed.url
  };
  const stored = await deps.store.put(issue.id, link);
  return { created: stored.created, link: stored.link };
}
