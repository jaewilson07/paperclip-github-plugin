import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import { ForgeItemAlreadyLinkedError, type ForgeLink } from '../src/forge-link.ts';
import {
  FORGE_LINK_ENTITY_TYPE,
  LEGACY_ISSUE_LINK_ENTITY_TYPE,
  LEGACY_PULL_REQUEST_LINK_ENTITY_TYPE,
  createEntityForgeLinkStore,
  type ForgeLinkEntities
} from '../src/forge-link-store.ts';
import manifest from '../src/manifest.ts';

function entities(): ForgeLinkEntities {
  return createTestHarness({ manifest }).ctx.entities;
}

/** What `upsertGitHubIssueLinkRecord` in worker.ts writes. */
async function seedOldIssueLink(store: ForgeLinkEntities, paperclipIssueId: string, number: number): Promise<void> {
  const githubIssueUrl = `https://github.com/JaeWilson07/Example/issues/${number}`;
  await store.upsert({
    entityType: LEGACY_ISSUE_LINK_ENTITY_TYPE,
    scopeKind: 'issue',
    scopeId: paperclipIssueId,
    externalId: githubIssueUrl,
    title: `GitHub issue #${number}`,
    status: 'open',
    data: {
      companyId: 'company-1',
      repositoryUrl: 'https://github.com/JaeWilson07/Example',
      githubIssueId: 9000 + number,
      githubIssueNumber: number,
      githubIssueUrl,
      githubIssueState: 'open',
      commentsCount: 0,
      linkedPullRequestNumbers: [],
      linkedPullRequests: [],
      labels: [],
      syncedAt: '2026-01-01T00:00:00.000Z'
    }
  });
}

/** What `upsertGitHubPullRequestLinkRecord` in worker.ts writes. */
async function seedOldPullRequestLink(store: ForgeLinkEntities, paperclipIssueId: string, number: number): Promise<void> {
  const githubPullRequestUrl = `https://github.com/jaewilson07/other/pull/${number}`;
  await store.upsert({
    entityType: LEGACY_PULL_REQUEST_LINK_ENTITY_TYPE,
    scopeKind: 'issue',
    scopeId: paperclipIssueId,
    externalId: githubPullRequestUrl,
    title: `GitHub pull request #${number}`,
    status: 'open',
    data: {
      companyId: 'company-1',
      repositoryUrl: 'https://github.com/jaewilson07/other',
      githubPullRequestNumber: number,
      githubPullRequestUrl,
      githubPullRequestState: 'open',
      title: 'A pull request',
      syncedAt: '2026-01-01T00:00:00.000Z'
    }
  });
}

const giteaLink: ForgeLink = {
  forge: 'gitea',
  host: 'Git.Example.com',
  repository: 'Team/Repo',
  number: 4,
  kind: 'issue',
  url: 'https://git.example.com/team/repo/issues/4'
};

test('a new link is stored as forge, host, repository, number and kind', async () => {
  const backing = entities();
  const store = createEntityForgeLinkStore(backing, { companyId: 'company-1' });
  assert.equal((await store.put('issue-1', giteaLink)).created, true);

  const [row] = await backing.list({ entityType: FORGE_LINK_ENTITY_TYPE });
  assert.equal(row!.scopeId, 'issue-1');
  assert.equal(row!.externalId, 'gitea:git.example.com/team/repo#4');
  assert.deepEqual(
    { ...row!.data, linkedAt: undefined },
    { forge: 'gitea', host: 'git.example.com', repository: 'team/repo', number: 4, kind: 'issue', url: giteaLink.url, companyId: 'company-1', linkedAt: undefined }
  );
  assert.deepEqual(await store.list('issue-1'), [{ ...giteaLink, host: 'git.example.com', repository: 'team/repo' }]);
});

test('old GitHub issue and pull request links read through the new shape', async () => {
  const backing = entities();
  await seedOldIssueLink(backing, 'issue-1', 7);
  await seedOldPullRequestLink(backing, 'issue-1', 12);
  const store = createEntityForgeLinkStore(backing);

  assert.deepEqual(await store.list('issue-1'), [
    { forge: 'github', host: 'github.com', repository: 'jaewilson07/example', number: 7, kind: 'issue', url: 'https://github.com/JaeWilson07/Example/issues/7' },
    { forge: 'github', host: 'github.com', repository: 'jaewilson07/other', number: 12, kind: 'pull_request', url: 'https://github.com/jaewilson07/other/pull/12' }
  ]);
  assert.equal(await store.findPaperclipIssue({ forge: 'github', host: 'github.com', repository: 'JaeWilson07/Example', number: 7, kind: 'issue' }), 'issue-1');
});

test('old and new links on one issue list together, oldest first', async () => {
  const backing = entities();
  await seedOldIssueLink(backing, 'issue-1', 7);
  const store = createEntityForgeLinkStore(backing, { now: () => new Date('2027-01-01T00:00:00.000Z') });
  await store.put('issue-1', giteaLink);
  assert.deepEqual((await store.list('issue-1')).map((link) => link.forge), ['github', 'gitea']);
});

test('put of an item that already has an old link is a no-op on the same issue and a conflict on another', async () => {
  const backing = entities();
  await seedOldIssueLink(backing, 'issue-1', 7);
  const store = createEntityForgeLinkStore(backing);
  const item: ForgeLink = { forge: 'github', host: 'github.com', repository: 'jaewilson07/example', number: 7, kind: 'issue', url: 'https://github.com/jaewilson07/example/issues/7' };

  const repeat = await store.put('issue-1', item);
  assert.equal(repeat.created, false);
  assert.equal(repeat.link.url, 'https://github.com/JaeWilson07/Example/issues/7');
  await assert.rejects(store.put('issue-2', { ...item, kind: 'pull_request' }), ForgeItemAlreadyLinkedError);
  assert.equal((await backing.list({ entityType: FORGE_LINK_ENTITY_TYPE })).length, 0);
});

test('concurrent puts of one item to two issues link it once', async () => {
  const store = createEntityForgeLinkStore(entities());
  const results = await Promise.allSettled([store.put('issue-1', giteaLink), store.put('issue-2', giteaLink)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof ForgeItemAlreadyLinkedError);
});

test('remove tombstones old issue and pull request links the way the operator unlink does', async () => {
  const backing = entities();
  await seedOldIssueLink(backing, 'issue-1', 7);
  await seedOldPullRequestLink(backing, 'issue-1', 12);
  const store = createEntityForgeLinkStore(backing, { now: () => new Date('2027-02-02T00:00:00.000Z') });

  await store.remove('issue-1', { forge: 'github', host: 'github.com', repository: 'jaewilson07/example', number: 7, kind: 'issue' });
  await store.remove('issue-1', { forge: 'github', host: 'github.com', repository: 'jaewilson07/other', number: 12, kind: 'pull_request' });

  assert.deepEqual(await store.list('issue-1'), []);
  const [issueRow] = await backing.list({ entityType: LEGACY_ISSUE_LINK_ENTITY_TYPE });
  assert.equal(issueRow!.status, 'unlinked');
  assert.deepEqual(issueRow!.data, {
    kind: 'issue',
    paperclipIssueId: 'issue-1',
    repositoryUrl: 'https://github.com/JaeWilson07/Example',
    githubIssueNumber: 7,
    githubIssueUrl: 'https://github.com/JaeWilson07/Example/issues/7',
    companyId: 'company-1',
    unlinkedAt: '2027-02-02T00:00:00.000Z'
  });
  const [pullRequestRow] = await backing.list({ entityType: LEGACY_PULL_REQUEST_LINK_ENTITY_TYPE });
  assert.equal(pullRequestRow!.status, 'unlinked');
  assert.equal(pullRequestRow!.data.githubPullRequestNumber, 12);
  assert.equal((await store.put('issue-2', { forge: 'github', host: 'github.com', repository: 'jaewilson07/example', number: 7, kind: 'issue', url: 'https://github.com/jaewilson07/example/issues/7' })).created, true);
});

test('remove of a new link frees the item for another ticket', async () => {
  const backing = entities();
  const store = createEntityForgeLinkStore(backing);
  await store.put('issue-1', giteaLink);
  await store.remove('issue-1', giteaLink);
  await store.remove('issue-1', giteaLink);

  assert.deepEqual(await store.list('issue-1'), []);
  assert.equal(await store.findPaperclipIssue(giteaLink), undefined);
  assert.equal((await store.put('issue-2', giteaLink)).created, true);
  assert.equal(await store.findPaperclipIssue(giteaLink), 'issue-2');
});

test('remove on the wrong issue leaves the link alone', async () => {
  const backing = entities();
  await seedOldIssueLink(backing, 'issue-1', 7);
  const store = createEntityForgeLinkStore(backing);
  await store.remove('issue-2', { forge: 'github', host: 'github.com', repository: 'jaewilson07/example', number: 7, kind: 'issue' });
  assert.equal((await store.list('issue-1')).length, 1);
});

test('records worker.ts would not resolve are skipped, not thrown on', async () => {
  const backing = entities();
  await backing.upsert({ entityType: LEGACY_ISSUE_LINK_ENTITY_TYPE, scopeKind: 'issue', scopeId: 'issue-1', externalId: 'x', data: { repositoryUrl: 'not a repo' } });
  await backing.upsert({ entityType: FORGE_LINK_ENTITY_TYPE, scopeKind: 'issue', scopeId: 'issue-1', externalId: 'y', data: { forge: 'svn' } });
  assert.deepEqual(await createEntityForgeLinkStore(backing).list('issue-1'), []);
});
