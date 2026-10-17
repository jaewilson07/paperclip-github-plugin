/**
 * The plugin's real `ForgeLinkStore` (DAT-1427), kept on plugin entities.
 *
 * New links are `paperclip-github-plugin.forge-link` entities in the forge-neutral shape. Links
 * written before ADR-062 are the GitHub-shaped `issue-link` and `pull-request-link` entities that
 * worker.ts still writes and reads; this store reads them through the same shape so nothing is
 * re-linked, and `remove` tombstones them exactly as the operator unlink action does.
 *
 * The entity API is upsert and list only, so the one-item-one-issue rule is enforced by
 * serialising every `put` and `remove` for one forge item through a lock in the worker process.
 * worker.ts's own GitHub link writers do not take that lock.
 */
import type { PluginEntitiesClient, PluginEntityRecord } from '@paperclipai/plugin-sdk';

import {
  ForgeItemAlreadyLinkedError,
  forgeItemKey,
  normalizeForgeItemRef,
  type ForgeItemKind,
  type ForgeItemRef,
  type ForgeLink,
  type ForgeLinkStore
} from './forge-link.ts';
import { parseRepositoryReference } from './github-repo.ts';

export const FORGE_LINK_ENTITY_TYPE = 'paperclip-github-plugin.forge-link';
/** Same values as `ISSUE_LINK_ENTITY_TYPE` and `PULL_REQUEST_LINK_ENTITY_TYPE` in worker.ts. */
export const LEGACY_ISSUE_LINK_ENTITY_TYPE = 'paperclip-github-plugin.issue-link';
export const LEGACY_PULL_REQUEST_LINK_ENTITY_TYPE = 'paperclip-github-plugin.pull-request-link';

const UNLINKED_STATUS = 'unlinked';
const LINKED_STATUS = 'linked';
const PAGE_SIZE = 100;

export type ForgeLinkEntities = Pick<PluginEntitiesClient, 'list' | 'upsert'>;

export interface EntityForgeLinkStoreOptions {
  /** Stamped on new link records so company-scoped readers can filter them. */
  companyId?: string;
  now?: () => Date;
}

/** A live link read from storage, with what `remove` needs to tombstone it. */
interface StoredForgeLink {
  paperclipIssueId: string;
  link: ForgeLink;
  linkedAt: string;
  entity: PluginEntityRecord;
}

export function createEntityForgeLinkStore(
  entities: ForgeLinkEntities,
  options: EntityForgeLinkStoreOptions = {}
): ForgeLinkStore {
  const now = options.now ?? (() => new Date());

  async function listStored(paperclipIssueId?: string): Promise<StoredForgeLink[]> {
    const stored: StoredForgeLink[] = [];
    for (const entityType of [FORGE_LINK_ENTITY_TYPE, LEGACY_ISSUE_LINK_ENTITY_TYPE, LEGACY_PULL_REQUEST_LINK_ENTITY_TYPE]) {
      for (const entity of await listAllEntities(entities, entityType, paperclipIssueId)) {
        const entry = readStoredForgeLink(entity);
        if (entry && (!paperclipIssueId || entry.paperclipIssueId === paperclipIssueId)) {
          stored.push(entry);
        }
      }
    }
    return stored.sort((left, right) => left.linkedAt.localeCompare(right.linkedAt));
  }

  async function findOwner(key: string): Promise<StoredForgeLink | undefined> {
    return (await listStored()).find((entry) => forgeItemKey(entry.link) === key);
  }

  return {
    async list(paperclipIssueId) {
      return (await listStored(paperclipIssueId)).map((entry) => ({ ...entry.link }));
    },

    async put(paperclipIssueId, link) {
      const normalized: ForgeLink = { ...normalizeForgeItemRef(link), url: link.url };
      const key = forgeItemKey(normalized);
      return withItemLock(key, async () => {
        const owner = await findOwner(key);
        if (owner && owner.paperclipIssueId !== paperclipIssueId) {
          throw new ForgeItemAlreadyLinkedError(normalized, owner.paperclipIssueId);
        }
        if (owner) {
          return { link: { ...owner.link }, created: false };
        }
        await entities.upsert({
          entityType: FORGE_LINK_ENTITY_TYPE,
          scopeKind: 'issue',
          scopeId: paperclipIssueId,
          externalId: key,
          title: forgeLinkTitle(normalized),
          status: LINKED_STATUS,
          data: {
            ...normalized,
            ...(options.companyId ? { companyId: options.companyId } : {}),
            linkedAt: now().toISOString()
          }
        });
        return { link: { ...normalized }, created: true };
      });
    },

    async remove(paperclipIssueId, item) {
      const key = forgeItemKey(item);
      await withItemLock(key, async () => {
        const unlinkedAt = now().toISOString();
        for (const entry of await listStored(paperclipIssueId)) {
          if (forgeItemKey(entry.link) === key) {
            await entities.upsert(buildTombstone(entry, unlinkedAt));
          }
        }
      });
    },

    async findPaperclipIssue(item) {
      return (await findOwner(forgeItemKey(item)))?.paperclipIssueId;
    }
  };
}

async function listAllEntities(
  entities: ForgeLinkEntities,
  entityType: string,
  paperclipIssueId: string | undefined
): Promise<PluginEntityRecord[]> {
  const all: PluginEntityRecord[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await entities.list({
      entityType,
      scopeKind: 'issue',
      ...(paperclipIssueId ? { scopeId: paperclipIssueId } : {}),
      limit: PAGE_SIZE,
      offset
    });
    all.push(...page);
    if (page.length < PAGE_SIZE) {
      return all;
    }
  }
}

function readStoredForgeLink(entity: PluginEntityRecord): StoredForgeLink | null {
  if (entity.scopeKind !== 'issue' || !entity.scopeId || entity.status === UNLINKED_STATUS) {
    return null;
  }
  const link = entity.entityType === FORGE_LINK_ENTITY_TYPE ? readForgeLinkData(entity.data) : readLegacyGitHubLinkData(entity);
  if (!link) {
    return null;
  }
  const linkedAt = typeof entity.data.linkedAt === 'string' ? entity.data.linkedAt : entity.createdAt;
  return { paperclipIssueId: entity.scopeId, link, linkedAt, entity };
}

function readForgeLinkData(data: Record<string, unknown>): ForgeLink | null {
  if (typeof data.url !== 'string') {
    return null;
  }
  try {
    return { ...normalizeForgeItemRef(data as unknown as ForgeItemRef), url: data.url };
  } catch {
    return null;
  }
}

/**
 * Old GitHub-shaped records. Only the fields every writer sets are needed; a record missing any
 * of them is not a link worker.ts would resolve either.
 */
function readLegacyGitHubLinkData(entity: PluginEntityRecord): ForgeLink | null {
  const kind: ForgeItemKind = entity.entityType === LEGACY_PULL_REQUEST_LINK_ENTITY_TYPE ? 'pull_request' : 'issue';
  const data = entity.data;
  const number = kind === 'issue' ? data.githubIssueNumber : data.githubPullRequestNumber;
  const url = kind === 'issue' ? data.githubIssueUrl : data.githubPullRequestUrl;
  const repository = typeof data.repositoryUrl === 'string' ? parseRepositoryReference(data.repositoryUrl) : null;
  if (!repository || typeof number !== 'number' || typeof url !== 'string') {
    return null;
  }
  try {
    const ref = normalizeForgeItemRef({
      forge: 'github',
      host: 'github.com',
      repository: `${repository.owner}/${repository.repo}`,
      number,
      kind
    });
    return { ...ref, url: url.trim() };
  } catch {
    return null;
  }
}

/**
 * Old records get the tombstone worker.ts writes in `tombstoneGitHubIssueLinkRecord` and
 * `tombstoneGitHubPullRequestLinkRecord`, so both readers agree the link is gone. Removing an old
 * issue link here does not touch the import registry or the issue's origin markers; the operator
 * unlink action still does that.
 */
function buildTombstone(entry: StoredForgeLink, unlinkedAt: string): Parameters<ForgeLinkEntities['upsert']>[0] {
  const { entity, link, paperclipIssueId } = entry;
  const base = {
    entityType: entity.entityType,
    scopeKind: 'issue' as const,
    scopeId: paperclipIssueId,
    ...(entity.externalId ? { externalId: entity.externalId } : {}),
    ...(entity.title ? { title: entity.title } : {}),
    status: UNLINKED_STATUS
  };
  const company = {
    ...(typeof entity.data.companyId === 'string' ? { companyId: entity.data.companyId } : {}),
    ...(typeof entity.data.paperclipProjectId === 'string' ? { paperclipProjectId: entity.data.paperclipProjectId } : {})
  };
  if (entity.entityType === FORGE_LINK_ENTITY_TYPE) {
    return { ...base, data: { ...entity.data, unlinkedAt } };
  }
  const numberAndUrl = link.kind === 'issue'
    ? { githubIssueNumber: link.number, githubIssueUrl: link.url }
    : { githubPullRequestNumber: link.number, githubPullRequestUrl: link.url };
  return {
    ...base,
    data: { kind: link.kind, paperclipIssueId, repositoryUrl: entity.data.repositoryUrl, ...numberAndUrl, ...company, unlinkedAt }
  };
}

function forgeLinkTitle(link: ForgeLink): string {
  return `${link.repository}#${link.number}`;
}

const itemLockTails = new Map<string, Promise<void>>();

async function withItemLock<T>(key: string, mutation: () => Promise<T>): Promise<T> {
  const previous = itemLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  itemLockTails.set(key, tail);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (itemLockTails.get(key) === tail) {
      itemLockTails.delete(key);
    }
  }
}
