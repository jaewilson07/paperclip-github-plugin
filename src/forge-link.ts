/**
 * Forge-neutral link between a Paperclip issue and an item on a code forge (ADR-062).
 *
 * This module is the contract. DAT-1427 supplies the real store behind `ForgeLinkStore`;
 * DAT-1428 (push) and DAT-1430 (status return) build against the interface and test with
 * `createInMemoryForgeLinkStore`. Keep callers off the plugin's GitHub-specific link records.
 */

/** Forges the plugin can link to. Add a value when a second adapter exists. */
export type ForgeName = 'github' | 'gitea';

export type ForgeItemKind = 'issue' | 'pull_request';

/** Identifies one item on a forge. Equal coordinates mean the same item. */
export interface ForgeItemRef {
  forge: ForgeName;
  /** `owner/name`, lower-cased for comparison. */
  repository: string;
  number: number;
  kind: ForgeItemKind;
}

export interface ForgeLink extends ForgeItemRef {
  /** Web URL of the item. Display only; identity is the coordinates above. */
  url: string;
}

export interface ForgeLinkStore {
  /** Every link on a Paperclip issue, oldest first. Reads old-shape GitHub links too. */
  list(paperclipIssueId: string): Promise<ForgeLink[]>;
  /** Adds the link. Putting an equal item again is a no-op and returns the stored link. */
  put(paperclipIssueId: string, link: ForgeLink): Promise<ForgeLink>;
  /** Removes the link to this item. Removing a link that is not there is a no-op. */
  remove(paperclipIssueId: string, item: ForgeItemRef): Promise<void>;
  /** The Paperclip issue linked to this forge item, if any. */
  findPaperclipIssue(item: ForgeItemRef): Promise<string | undefined>;
}

export class InvalidForgeItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidForgeItemError';
  }
}

/** Canonical form used for equality and storage: trimmed, repository lower-cased. */
export function normalizeForgeItemRef(item: ForgeItemRef): ForgeItemRef {
  const repository = item.repository.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new InvalidForgeItemError(`Forge repository must look like "owner/name", got "${item.repository}".`);
  }
  if (!Number.isInteger(item.number) || item.number < 1) {
    throw new InvalidForgeItemError(`Forge item number must be a positive integer, got ${item.number}.`);
  }
  return { forge: item.forge, repository, number: item.number, kind: item.kind };
}

export function forgeItemKey(item: ForgeItemRef): string {
  const n = normalizeForgeItemRef(item);
  return `${n.forge}:${n.repository}#${n.kind}:${n.number}`;
}

/** In-memory store for tests of code that depends on the contract. */
export function createInMemoryForgeLinkStore(): ForgeLinkStore {
  const byIssue = new Map<string, ForgeLink[]>();

  return {
    async list(paperclipIssueId) {
      return [...(byIssue.get(paperclipIssueId) ?? [])];
    },
    async put(paperclipIssueId, link) {
      const normalized = { ...link, ...normalizeForgeItemRef(link) };
      const links = byIssue.get(paperclipIssueId) ?? [];
      const existing = links.find((entry) => forgeItemKey(entry) === forgeItemKey(normalized));
      if (existing) {
        return existing;
      }
      byIssue.set(paperclipIssueId, [...links, normalized]);
      return normalized;
    },
    async remove(paperclipIssueId, item) {
      const key = forgeItemKey(item);
      byIssue.set(
        paperclipIssueId,
        (byIssue.get(paperclipIssueId) ?? []).filter((entry) => forgeItemKey(entry) !== key)
      );
    },
    async findPaperclipIssue(item) {
      const key = forgeItemKey(item);
      for (const [issueId, links] of byIssue) {
        if (links.some((entry) => forgeItemKey(entry) === key)) {
          return issueId;
        }
      }
      return undefined;
    }
  };
}
