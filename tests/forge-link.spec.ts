import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ForgeItemAlreadyLinkedError,
  InvalidForgeItemError,
  createInMemoryForgeLinkStore,
  forgeItemKey,
  normalizeForgeItemRef,
  type ForgeLink
} from '../src/forge-link.ts';

const link: ForgeLink = {
  forge: 'github',
  host: 'GitHub.com',
  repository: 'JaeWilson07/Example',
  number: 7,
  kind: 'issue',
  url: 'https://github.com/jaewilson07/example/issues/7'
};

test('host and repository case do not change identity', () => {
  assert.equal(forgeItemKey(link), forgeItemKey({ ...link, host: 'github.com', repository: 'jaewilson07/example' }));
});

test('an issue and a pull request share one number space, so kind is not identity', () => {
  assert.equal(forgeItemKey(link), forgeItemKey({ ...link, kind: 'pull_request' }));
});

test('the same owner/name and number on two instances are different items', () => {
  assert.notEqual(forgeItemKey({ ...link, forge: 'gitea', host: 'git.one.example' }), forgeItemKey({ ...link, forge: 'gitea', host: 'git.two.example' }));
});

test('invalid forge, kind, host, repository or number is rejected with a named error', () => {
  assert.throws(() => normalizeForgeItemRef({ ...link, forge: 'svn' as never }), InvalidForgeItemError);
  assert.throws(() => normalizeForgeItemRef({ ...link, kind: 'commit' as never }), InvalidForgeItemError);
  assert.throws(() => normalizeForgeItemRef({ ...link, host: 'https://github.com' }), InvalidForgeItemError);
  assert.throws(() => normalizeForgeItemRef({ ...link, repository: 'no-slash' }), InvalidForgeItemError);
  assert.throws(() => normalizeForgeItemRef({ ...link, number: 0 }), InvalidForgeItemError);
});

test('put reports created, then is a no-op that returns the stored link', async () => {
  const store = createInMemoryForgeLinkStore();
  const first = await store.put('issue-1', link);
  const second = await store.put('issue-1', { ...link, repository: 'jaewilson07/example' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.link, first.link);
  assert.equal((await store.list('issue-1')).length, 1);
});

test('one forge item cannot link to two Paperclip issues', async () => {
  const store = createInMemoryForgeLinkStore();
  await store.put('issue-1', link);
  await assert.rejects(store.put('issue-2', link), (error) => {
    assert.ok(error instanceof ForgeItemAlreadyLinkedError);
    assert.equal(error.paperclipIssueId, 'issue-1');
    return true;
  });
  assert.equal((await store.list('issue-2')).length, 0);
});

test('findPaperclipIssue resolves a forge item back to its ticket, whatever its kind', async () => {
  const store = createInMemoryForgeLinkStore();
  await store.put('issue-1', link);
  assert.equal(await store.findPaperclipIssue({ ...link, host: 'github.com', repository: 'jaewilson07/example', kind: 'pull_request' }), 'issue-1');
  assert.equal(await store.findPaperclipIssue({ ...link, number: 8 }), undefined);
});

test('remove deletes only the named item, frees it for another ticket, and tolerates a missing one', async () => {
  const store = createInMemoryForgeLinkStore();
  await store.put('issue-1', link);
  await store.put('issue-1', { ...link, number: 9, url: 'https://github.com/jaewilson07/example/issues/9' });
  await store.remove('issue-1', link);
  await store.remove('issue-1', link);
  assert.deepEqual((await store.list('issue-1')).map((entry) => entry.number), [9]);
  assert.equal((await store.put('issue-2', link)).created, true);
});

test('list returns copies, so a caller cannot change the store', async () => {
  const store = createInMemoryForgeLinkStore();
  await store.put('issue-1', link);
  (await store.list('issue-1'))[0]!.number = 99;
  assert.equal((await store.list('issue-1'))[0]!.number, 7);
});
