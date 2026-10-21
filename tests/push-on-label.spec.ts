import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createInMemoryForgeLinkStore } from '../src/forge-link.ts';
import { pushIssueToGitHub, type PushIssueDeps } from '../src/push-issue.ts';
import {
  pushNow,
  runPushOnLabelTick,
  type PushOnLabelDeps,
  type PushOnLabelIssue
} from '../src/push-on-label.ts';

const ready = [{ name: 'ready-for-agent' }];

function issue(id: string, overrides: Partial<PushOnLabelIssue> = {}): PushOnLabelIssue {
  return { id, identifier: id.toUpperCase(), status: 'todo', projectId: 'project-1', labels: ready, ...overrides };
}

/** Wires the tick to the real `pushIssueToGitHub`, so retry and duplicate rules are exercised end to end. */
function createHarness(issues: PushOnLabelIssue[], options: { failCreateTimes?: number; noRepository?: boolean } = {}) {
  const store = createInMemoryForgeLinkStore();
  const created: string[] = [];
  const comments: Array<{ issueId: string; message: string }> = [];
  const failures = new Map<string, string>();
  let failuresLeft = options.failCreateTimes ?? 0;
  let nextNumber = 100;

  const pushDeps = (id: string): PushIssueDeps => ({
    store,
    getIssue: async () => {
      const found = issues.find((entry) => entry.id === id)!;
      return { id, identifier: found.identifier ?? id, title: `Title ${id}`, projectId: found.projectId };
    },
    resolveRepository: async () => ({ host: 'github.com', repository: 'acme/widgets' }),
    findIssueByMarker: async () => [],
    createIssue: async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('GitHub is down');
      }
      nextNumber += 1;
      created.push(id);
      return { number: nextNumber, url: `https://github.com/acme/widgets/issues/${nextNumber}` };
    }
  });

  const deps: PushOnLabelDeps = {
    listIssues: async () => issues,
    getIssue: async (id) => issues.find((entry) => entry.id === id) ?? null,
    loadLabels: async () => [],
    hasLink: async (id) => (await store.list(id)).length > 0,
    projectHasRepository: async () => !options.noRepository,
    push: async (id) => (await pushIssueToGitHub(pushDeps(id), { paperclipIssueId: id })).link,
    lastReportedFailure: async (id) => failures.get(id),
    reportFailure: async (id, message) => {
      comments.push({ issueId: id, message });
      failures.set(id, message);
    },
    clearFailure: async (id) => {
      failures.delete(id);
    }
  };
  return { deps, store, created, comments };
}

test('a labelled, unlinked issue in a repo project is pushed on the tick', async () => {
  const { deps, store, created } = createHarness([issue('dat-1')]);
  const summary = await runPushOnLabelTick(deps);

  assert.equal(summary.pushed, 1);
  assert.deepEqual(created, ['dat-1']);
  assert.equal((await store.list('dat-1')).length, 1);
});

test('an unlabelled issue is never pushed', async () => {
  const { deps, created } = createHarness([
    issue('dat-1', { labels: [] }),
    issue('dat-2', { labels: [{ name: 'bug' }] })
  ]);
  const summary = await runPushOnLabelTick(deps);

  assert.equal(summary.outcomes.length, 0);
  assert.deepEqual(created, []);
  assert.deepEqual(await pushNow(deps, 'dat-1'), { issueId: 'dat-1', result: 'skipped', reason: 'no_label' });
  assert.deepEqual(created, []);
});

test('a labelled issue that already has a link is skipped', async () => {
  const { deps, created } = createHarness([issue('dat-1')]);
  await runPushOnLabelTick(deps);
  const second = await runPushOnLabelTick(deps);

  assert.deepEqual(created, ['dat-1']);
  assert.deepEqual(second.outcomes, [{ issueId: 'dat-1', result: 'skipped', reason: 'linked' }]);
});

test('issues without a repository, without a project or closed are skipped', async () => {
  const noRepo = createHarness([issue('dat-1')], { noRepository: true });
  assert.deepEqual((await runPushOnLabelTick(noRepo.deps)).outcomes, [
    { issueId: 'dat-1', result: 'skipped', reason: 'no_repository' }
  ]);

  const other = createHarness([issue('dat-2', { projectId: null }), issue('dat-3', { status: 'done' })]);
  const reasons = (await runPushOnLabelTick(other.deps)).outcomes.map((outcome) => outcome.result === 'skipped' && outcome.reason);
  assert.deepEqual(reasons, ['no_project', 'closed']);
  assert.deepEqual(other.created, []);
});

test('a failed push leaves no link, is reported once and is retried without a duplicate', async () => {
  const { deps, store, created, comments } = createHarness([issue('dat-1')], { failCreateTimes: 2 });

  const first = await runPushOnLabelTick(deps);
  assert.equal(first.failed, 1);
  assert.deepEqual(await store.list('dat-1'), []);
  assert.equal(comments.length, 1);
  assert.match(comments[0].message, /GitHub is down/);

  const second = await runPushOnLabelTick(deps);
  assert.equal(second.failed, 1);
  assert.equal(comments.length, 1, 'the same failure is not reported again');

  const third = await runPushOnLabelTick(deps);
  assert.equal(third.pushed, 1);
  assert.deepEqual(created, ['dat-1']);
  assert.equal((await store.list('dat-1')).length, 1);
});

test('one failing issue does not stop the others', async () => {
  const { deps, created } = createHarness([issue('dat-1'), issue('dat-2')], { failCreateTimes: 1 });
  const summary = await runPushOnLabelTick(deps);

  assert.equal(summary.failed, 1);
  assert.equal(summary.pushed, 1);
  assert.deepEqual(created, ['dat-2']);
});

test('push now pushes a single labelled issue and reports a missing one', async () => {
  const { deps, created } = createHarness([issue('dat-1'), issue('dat-2')]);
  const outcome = await pushNow(deps, 'dat-2');

  assert.equal(outcome.result, 'pushed');
  assert.deepEqual(created, ['dat-2']);
  assert.deepEqual(await pushNow(deps, 'missing'), { issueId: 'missing', result: 'skipped', reason: 'not_found' });
});

test('labels missing from the listing are loaded per issue', async () => {
  const { deps, created } = createHarness([issue('dat-1', { labels: null }), issue('dat-2', { labels: null })]);
  deps.loadLabels = async (id) => (id === 'dat-2' ? ['Ready-For-Agent'] : ['bug']);
  await runPushOnLabelTick(deps);

  assert.deepEqual(created, ['dat-2']);
});
