import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatSkippedByAgeSummary,
  normalizeImportMaxAgeDays,
  partitionIssuesByImportAge,
  resolveImportMaxAgeDays,
  validateImportMaxAgeDays
} from '../src/import-age-filter.ts';

const now = new Date('2026-10-26T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const recent = { id: 1, state: 'open', updatedAt: daysAgo(5) };
const old = { id: 2, state: 'open', updatedAt: daysAgo(143) };

test('filter unset imports everything as today', () => {
  const result = partitionIssuesByImportAge({ issues: [recent, old], maxAgeDays: undefined, now });
  assert.deepEqual(result.eligible, [recent, old]);
  assert.deepEqual(result.skippedByAge, []);
});

test('recent issue imports and older issue is skipped and counted', () => {
  const result = partitionIssuesByImportAge({ issues: [recent, old], maxAgeDays: 60, now });
  assert.deepEqual(result.eligible, [recent]);
  assert.deepEqual(result.skippedByAge, [old]);
});

test('an old issue that gets a new comment imports on the next sync', () => {
  const before = partitionIssuesByImportAge({ issues: [old], maxAgeDays: 60, now });
  assert.equal(before.skippedByAge.length, 1);
  const commented = { ...old, updatedAt: daysAgo(0) };
  const after = partitionIssuesByImportAge({ issues: [commented], maxAgeDays: 60, now });
  assert.deepEqual(after.eligible, [commented]);
});

test('an already imported or linked old issue keeps syncing', () => {
  const result = partitionIssuesByImportAge({
    issues: [old],
    maxAgeDays: 60,
    now,
    isExempt: (issue) => issue.id === 2
  });
  assert.deepEqual(result.eligible, [old]);
  assert.deepEqual(result.skippedByAge, []);
});

test('the cutoff is inclusive and a missing timestamp is never dropped', () => {
  const boundary = { id: 3, state: 'open', updatedAt: daysAgo(60) };
  const unknown = { id: 4, state: 'open' };
  const result = partitionIssuesByImportAge({ issues: [boundary, unknown], maxAgeDays: 60, now });
  assert.deepEqual(result.eligible, [boundary, unknown]);
});

test('per-mapping value overrides the company default', () => {
  assert.equal(resolveImportMaxAgeDays(30, 60), 30);
  assert.equal(resolveImportMaxAgeDays(undefined, 60), 60);
  assert.equal(resolveImportMaxAgeDays(undefined, undefined), undefined);
});

test('invalid values are rejected and unset is accepted', () => {
  for (const bad of [0, -1, 3651, 1.5, 'abc', '12.5', '-3', NaN, Infinity, {}, true]) {
    assert.equal(validateImportMaxAgeDays(bad).valid, false, `expected ${String(bad)} to be rejected`);
  }
  for (const unset of [undefined, null, '', '  ']) {
    assert.deepEqual(validateImportMaxAgeDays(unset), { valid: true, value: undefined });
  }
  assert.deepEqual(validateImportMaxAgeDays(1), { valid: true, value: 1 });
  assert.deepEqual(validateImportMaxAgeDays('3650'), { valid: true, value: 3650 });
  assert.equal(normalizeImportMaxAgeDays(0), undefined);
  assert.equal(normalizeImportMaxAgeDays('60'), 60);
});

test('summary lists skipped counts per mapping', () => {
  assert.equal(
    formatSkippedByAgeSummary([
      { repositoryUrl: 'https://github.com/a/b', skippedCount: 143, maxAgeDays: 60 },
      { repositoryUrl: 'https://github.com/a/c', skippedCount: 0, maxAgeDays: 60 }
    ]),
    'https://github.com/a/b: skipped 143 older than 60 days'
  );
  assert.equal(formatSkippedByAgeSummary([]), undefined);
});
