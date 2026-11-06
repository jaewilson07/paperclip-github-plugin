/**
 * Status return (ADR-062, DAT-1430): keeps a Paperclip issue and its linked forge items in step on
 * close and cancel. Titles, bodies and comments are never synced; each status change leaves one
 * comment on the other side naming the cause.
 *
 * Rules:
 * - Merged pull request with its branch deleted closes the ticket (`done`). A merged pull request
 *   whose branch still exists leaves the ticket open.
 * - Forge issue closed as not planned cancels the ticket.
 * - Ticket cancelled in Paperclip closes the linked forge issue as not planned.
 * - The sync decides from current state only, never from stored history, so running it again after
 *   a change finds nothing to do. A ticket already `done` or `cancelled` is never moved by the forge.
 *
 * The module depends on narrow ports so it can sit behind any forge adapter and is tested without a
 * network. Link identity comes from `ForgeLinkStore` (forge-link.ts).
 */

import { forgeItemKey, type ForgeItemRef, type ForgeLink, type ForgeLinkStore } from './forge-link.ts';

export type PaperclipIssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';

const TERMINAL_STATUSES: readonly PaperclipIssueStatus[] = ['done', 'cancelled'];

export type ForgeItemState =
  | { kind: 'issue'; state: 'open' }
  | { kind: 'issue'; state: 'closed'; reason: 'completed' | 'not_planned' }
  | { kind: 'pull_request'; state: 'open' | 'closed_unmerged' }
  | { kind: 'pull_request'; state: 'merged'; branchDeleted: boolean };

/** Reads and writes forge items. One adapter per forge; state is always read live. */
export interface ForgeStatusClient {
  getState(item: ForgeItemRef): Promise<ForgeItemState>;
  /** Closes an issue as not planned and leaves the comment. */
  closeIssueAsNotPlanned(item: ForgeItemRef, comment: string): Promise<void>;
}

/** The slice of Paperclip the sync needs. */
export interface PaperclipStatusClient {
  getStatus(paperclipIssueId: string): Promise<PaperclipIssueStatus>;
  /** Sets the status and leaves the comment in one call. */
  setStatus(paperclipIssueId: string, status: 'done' | 'cancelled', comment: string): Promise<void>;
}

export type StatusReturnAction =
  | { type: 'ticket_done'; item: ForgeItemRef; comment: string }
  | { type: 'ticket_cancelled'; item: ForgeItemRef; comment: string }
  | { type: 'forge_issue_closed'; item: ForgeItemRef; comment: string };

export interface StatusReturnDeps {
  links: ForgeLinkStore;
  forge: ForgeStatusClient;
  paperclip: PaperclipStatusClient;
  /** Human identifier of the ticket, for example `DAT-1430`, used in forge comments. */
  describeTicket(paperclipIssueId: string): string | Promise<string>;
}

function describeItem(link: ForgeLink): string {
  const label = link.kind === 'pull_request' ? 'Pull request' : 'Issue';
  return `${label} ${link.repository}#${link.number} (${link.url})`;
}

/**
 * Syncs one ticket against all its links and returns the actions it took, empty when nothing
 * changed. Forge-to-Paperclip runs first, so a cancel that came from the forge is already closed
 * there and is not pushed back.
 */
export async function syncTicketStatus(deps: StatusReturnDeps, paperclipIssueId: string): Promise<StatusReturnAction[]> {
  const links = await deps.links.list(paperclipIssueId);
  if (links.length === 0) return [];

  const actions: StatusReturnAction[] = [];
  let status = await deps.paperclip.getStatus(paperclipIssueId);
  const states = new Map<string, ForgeItemState>();
  for (const link of links) {
    states.set(forgeItemKey(link), await deps.forge.getState(link));
  }

  // Forge -> Paperclip. A merged and branch-deleted pull request outranks a not-planned issue
  // because it is evidence the work shipped.
  if (!TERMINAL_STATUSES.includes(status)) {
    const shipped = links.find((link) => {
      const s = states.get(forgeItemKey(link));
      return s?.kind === 'pull_request' && s.state === 'merged' && s.branchDeleted;
    });
    const dropped = links.find((link) => {
      const s = states.get(forgeItemKey(link));
      return s?.kind === 'issue' && s.state === 'closed' && s.reason === 'not_planned';
    });
    if (shipped) {
      const comment = `${describeItem(shipped)} was merged and its branch deleted, so this ticket is closed.`;
      await deps.paperclip.setStatus(paperclipIssueId, 'done', comment);
      actions.push({ type: 'ticket_done', item: shipped, comment });
      status = 'done';
    } else if (dropped) {
      const comment = `${describeItem(dropped)} was closed as not planned, so this ticket is cancelled.`;
      await deps.paperclip.setStatus(paperclipIssueId, 'cancelled', comment);
      actions.push({ type: 'ticket_cancelled', item: dropped, comment });
      status = 'cancelled';
    }
  }

  // Paperclip -> forge. Only a cancelled ticket reaches out, and only to issues still open.
  if (status === 'cancelled') {
    const ticket = await deps.describeTicket(paperclipIssueId);
    for (const link of links) {
      const s = states.get(forgeItemKey(link));
      if (s?.kind !== 'issue' || s.state !== 'open') continue;
      const comment = `Closed as not planned: Paperclip ticket ${ticket} was cancelled.`;
      await deps.forge.closeIssueAsNotPlanned(link, comment);
      actions.push({ type: 'forge_issue_closed', item: link, comment });
    }
  }

  return actions;
}
