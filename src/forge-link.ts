/**
 * Forge-neutral link between a Paperclip issue and an item on a code forge (ADR-062).
 *
 * This module is the contract. DAT-1427 supplies the real store behind `ForgeLinkStore`;
 * DAT-1428 (push) and DAT-1430 (status return) build against the interface and test with
 * `createInMemoryForgeLinkStore`. Keep callers off the plugin's GitHub-specific link records.
 *
 * Rules every store must keep:
 * - One forge item links to at most one Paperclip issue. `put` enforces this atomically; a
 *   find-then-write implementation is not enough. A conflicting `put` throws
 *   `ForgeItemAlreadyLinkedError`.
 * - A link records identity only. A pull request's state (open, merged, branch deleted) is read
 *   from the forge by a separate client, never stored here.
 * - Pushing creates the forge item before `put` runs, so a crash between the two leaves an orphan.
 *   The push action closes that window by writing the Paperclip identifier into the forge issue
 *   body and searching for it before it creates a new issue.
 */

/** Forges the plugin can link to. Add a value when a second adapter exists. */
export const FORGE_NAMES = ['github', 'gitea'] as const;
export type ForgeName = (typeof FORGE_NAMES)[number];

export const FORGE_ITEM_KINDS = ['issue', 'pull_request'] as const;
export type ForgeItemKind = (typeof FORGE_ITEM_KINDS)[number];

/**
 * Identifies one item on a forge. Two refs with the same forge, host, repository and number are
 * the same item: issues and pull requests share one number space on GitHub and Gitea, so `kind` is
 * an attribute of the item and not part of its identity.
 */
export interface ForgeItemRef {
  forge: ForgeName;
  /** Instance host, for example `github.com` or `git.example.com`. Separates self-hosted instances. */
  host: string;
  /** `owner/name`. Compared case-insensitively. */
  repository: string;
  number: number;
  kind: ForgeItemKind;
}

export interface ForgeLink extends ForgeItemRef {
  /** Web URL of the item. Display only; identity is the coordinates above. */
  url: string;
}

export interface ForgeLinkPutResult {
  link: ForgeLink;
  /** False when the same item was already linked to this Paperclip issue. */
  created: boolean;
}

export interface ForgeLinkStore {
  /** Every link on a Paperclip issue, oldest first. Reads old-shape GitHub links too. Returns copies. */
  list(paperclipIssueId: string): Promise<ForgeLink[]>;
  /**
   * Adds the link. The same item already on this issue is a no-op (`created: false`, stored link
   * returned). The item already on another Paperclip issue throws `ForgeItemAlreadyLinkedError`.
   */
  put(paperclipIssueId: string, link: ForgeLink): Promise<ForgeLinkPutResult>;
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

export class ForgeItemAlreadyLinkedError extends Error {
  readonly paperclipIssueId: string;

  constructor(item: ForgeItemRef, paperclipIssueId: string) {
    super(`${forgeItemKey(item)} is already linked to Paperclip issue ${paperclipIssueId}.`);
    this.name = 'ForgeItemAlreadyLinkedError';
    this.paperclipIssueId = paperclipIssueId;
  }
}

/** Canonical form used for equality and storage: trimmed, host and repository lower-cased. */
export function normalizeForgeItemRef(item: ForgeItemRef): ForgeItemRef {
  if (!FORGE_NAMES.includes(item.forge)) {
    throw new InvalidForgeItemError(`Unknown forge "${String(item.forge)}".`);
  }
  if (!FORGE_ITEM_KINDS.includes(item.kind)) {
    throw new InvalidForgeItemError(`Unknown forge item kind "${String(item.kind)}".`);
  }
  const host = item.host.trim().toLowerCase();
  if (!host || /[\s/]/.test(host)) {
    throw new InvalidForgeItemError(`Forge host must be a bare host name, got "${item.host}".`);
  }
  const repository = item.repository.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new InvalidForgeItemError(`Forge repository must look like "owner/name", got "${item.repository}".`);
  }
  if (!Number.isInteger(item.number) || item.number < 1) {
    throw new InvalidForgeItemError(`Forge item number must be a positive integer, got ${item.number}.`);
  }
  return { forge: item.forge, host, repository, number: item.number, kind: item.kind };
}

/** Identity of the item. Does not include `kind`. */
export function forgeItemKey(item: ForgeItemRef): string {
  const n = normalizeForgeItemRef(item);
  return `${n.forge}:${n.host}/${n.repository}#${n.number}`;
}

/** In-memory store for tests of code that depends on the contract. */
export function createInMemoryForgeLinkStore(): ForgeLinkStore {
  const byIssue = new Map<string, ForgeLink[]>();
  const ownerByItem = new Map<string, string>();

  return {
    async list(paperclipIssueId) {
      return (byIssue.get(paperclipIssueId) ?? []).map((entry) => ({ ...entry }));
    },
    async put(paperclipIssueId, link) {
      const normalized: ForgeLink = { ...link, ...normalizeForgeItemRef(link) };
      const key = forgeItemKey(normalized);
      const owner = ownerByItem.get(key);
      if (owner !== undefined && owner !== paperclipIssueId) {
        throw new ForgeItemAlreadyLinkedError(normalized, owner);
      }
      const links = byIssue.get(paperclipIssueId) ?? [];
      const existing = links.find((entry) => forgeItemKey(entry) === key);
      if (existing) {
        return { link: { ...existing }, created: false };
      }
      byIssue.set(paperclipIssueId, [...links, normalized]);
      ownerByItem.set(key, paperclipIssueId);
      return { link: { ...normalized }, created: true };
    },
    async remove(paperclipIssueId, item) {
      const key = forgeItemKey(item);
      const remaining = (byIssue.get(paperclipIssueId) ?? []).filter((entry) => forgeItemKey(entry) !== key);
      if (remaining.length > 0) {
        byIssue.set(paperclipIssueId, remaining);
      } else {
        byIssue.delete(paperclipIssueId);
      }
      if (ownerByItem.get(key) === paperclipIssueId) {
        ownerByItem.delete(key);
      }
    },
    async findPaperclipIssue(item) {
      return ownerByItem.get(forgeItemKey(item));
    }
  };
}
