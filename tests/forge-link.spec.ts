import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  InvalidForgeItemError,
  createInMemoryForgeLinkStore,
  forgeItemKey,
  normalizeForgeItemRef,
  type ForgeLink
} from '../src/forge-link.ts';

const link: ForgeLink = {
  forge: 'github',
  repository: 'JaeWilson07/Example',
  number: 7,
  kind: 'issue',
  url: 'https://github.com/jaewilson07/example/issues/7'
};

test('repository case does not change identity', () => {
  assert.equal(forgeItemKey(link), forgeItemKey({ ...link, repository: 'jaewilson07/example' }));
});

test('an issue and a pull request with the same number are different items', () => {
  assert.notEqual(forgeItemKey(link), forgeItemKey({ ...link, kind: 'pull_request' }));
});

test('invalid repository or number is rejected with a named error', () => {
  assert.throws(() => normalizeForgeItemRef({ ...link, repository: 'no-slash' }), InvalidForgeItemError);
  assert.throws(() => normalizeForgeItemRef({ ...link, number: 0 }), InvalidForgeItemError);
});

test('put is idempotent and returns the stored link', async () => {
  const store = createInMemoryForgeLinkStore();
  const first = await store.put('issue-1', link);
  const second = await store.put('issue-1', { ...link, repository: 'jaewilson07/example' });
  assert.deepEqual(second, first);
  assert.equal((await store.list('issue-1')).length, 1);
});

test('findPaperclipIssue resolves a forge item back to its ticket', async () => {
  const store = createInMemoryForgeLinkStore();
  await store.put('issue-1', link);
  assert.equal(await store.findPaperclipIssue({ ...link, repository: 'jaewilson07/example' }), 'issue-1');
  assert.equal(await store.findPaperclipIssue({ ...link, number: 8 }), undefined);
});

test('remove deletes only the named item and tolerates a missing one', async () => {
  const store = createInMemoryForgeLinkStore();
  await store.put('issue-1', link);
  await store.put('issue-1', { ...link, number: 9, url: 'https://github.com/jaewilson07/example/issues/9' });
  await store.remove('issue-1', link);
  await store.remove('issue-1', link);
  assert.deepEqual((await store.list('issue-1')).map((entry) => entry.number), [9]);
});
