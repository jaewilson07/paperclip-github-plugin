import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRIFT_COMMENT_TEXT_LIMIT,
  buildDescriptionDriftComment,
  decideDescriptionDrift,
  hashDescription
} from '../src/description-drift.ts';

const github = 'GitHub text';

test('unchanged Paperclip text syncs as today', () => {
  const decision = decideDescriptionDrift({
    currentDescription: 'old',
    nextDescription: github,
    storedHash: hashDescription('old')
  });
  assert.deepEqual(decision, { action: 'write' });
});

test('matching texts are in sync and clear drift', () => {
  assert.deepEqual(
    decideDescriptionDrift({
      currentDescription: github,
      nextDescription: github,
      storedHash: hashDescription('something else'),
      storedDriftKey: 'x:y'
    }),
    { action: 'in_sync' }
  );
});

test('first run without a stored hash adopts the Paperclip text as baseline, not drift', () => {
  assert.deepEqual(
    decideDescriptionDrift({ currentDescription: 'edited', nextDescription: github }),
    { action: 'write' }
  );
});

test('edited Paperclip text is drift and is reported once per pair of texts', () => {
  const base = { currentDescription: 'edited', nextDescription: github, storedHash: hashDescription('old') };
  const first = decideDescriptionDrift(base);
  assert.equal(first.action, 'drift');
  assert.ok(first.action === 'drift' && first.report);
  const second = decideDescriptionDrift({
    ...base,
    storedDriftKey: first.action === 'drift' ? first.driftKey : undefined
  });
  assert.ok(second.action === 'drift' && !second.report);
  const changedGitHub = decideDescriptionDrift({
    ...base,
    nextDescription: 'GitHub changed again',
    storedDriftKey: first.action === 'drift' ? first.driftKey : undefined
  });
  assert.ok(changedGitHub.action === 'drift' && changedGitHub.report);
});

test('line endings do not count as an edit', () => {
  assert.equal(hashDescription('a\r\nb'), hashDescription('a\nb'));
});

test('drift comment holds both texts in full', () => {
  const body = buildDescriptionDriftComment({
    githubIssueUrl: 'https://github.com/o/r/issues/1',
    paperclipDescription: 'paperclip ``` text',
    githubDescription: github
  });
  assert.match(body, /paperclip ``` text/);
  assert.match(body, /GitHub text/);
  assert.doesNotMatch(body, /Truncated/);
});

test('drift comment truncates long texts with a note', () => {
  const long = 'x'.repeat(DRIFT_COMMENT_TEXT_LIMIT + 50);
  const body = buildDescriptionDriftComment({
    githubIssueUrl: 'https://github.com/o/r/issues/1',
    paperclipDescription: long,
    githubDescription: github
  });
  assert.match(body, new RegExp(`Truncated: showing the first ${DRIFT_COMMENT_TEXT_LIMIT} of ${long.length}`));
});
