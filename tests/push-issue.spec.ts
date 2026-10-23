import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createTestHarness } from '@paperclipai/plugin-sdk/testing';

import { createInMemoryForgeLinkStore } from '../src/forge-link.ts';
import manifest from '../src/manifest.ts';
import {
  bodyHasPushMarker,
  buildPushIssueBody,
  PushIssueRefusedError,
  pushIssueToGitHub,
  type PushedGitHubIssue,
  type PushIssueDeps,
  type PushIssueSource
} from '../src/push-issue.ts';

const issue: PushIssueSource = {
  id: 'issue-1',
  identifier: 'DAT-1428',
  title: 'Push a Paperclip issue to GitHub',
  description: 'Body text.',
  projectId: 'project-1'
};

function createDeps(overrides: Partial<PushIssueDeps> = {}) {
  const created: Array<{ title: string; body: string }> = [];
  const deps: PushIssueDeps = {
    store: createInMemoryForgeLinkStore(),
    getIssue: async () => issue,
    resolveRepository: async () => ({ host: 'github.com', repository: 'acme/widgets' }),
    findIssueByMarker: async () => [],
    createIssue: async (_repository, input) => {
      created.push(input);
      return { number: 41 + created.length, url: `https://github.com/acme/widgets/issues/${41 + created.length}` };
    },
    ...overrides
  };
  return { deps, created };
}

test('push creates one GitHub issue whose body carries the identifier and stores the link', async () => {
  const { deps, created } = createDeps();
  const result = await pushIssueToGitHub(deps, { paperclipIssueId: issue.id });

  assert.equal(result.created, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, issue.title);
  assert.ok(bodyHasPushMarker(created[0].body, 'DAT-1428'));
  assert.deepEqual(await deps.store.list(issue.id), [result.link]);
  assert.equal(result.link.url, 'https://github.com/acme/widgets/issues/42');
});

test('a second push is a no-op that returns the existing link', async () => {
  const { deps, created } = createDeps();
  const first = await pushIssueToGitHub(deps, { paperclipIssueId: issue.id });
  const second = await pushIssueToGitHub(deps, { paperclipIssueId: issue.id });

  assert.equal(created.length, 1);
  assert.equal(second.created, false);
  assert.deepEqual(second.link, first.link);
});

test('a project with no repository is refused with the resolver message and nothing is created', async () => {
  const { deps, created } = createDeps({
    resolveRepository: async () => {
      throw new PushIssueRefusedError('The Paperclip project of DAT-1428 has no GitHub repository.');
    }
  });

  await assert.rejects(pushIssueToGitHub(deps, { paperclipIssueId: issue.id }), (error: Error) => {
    assert.ok(error instanceof PushIssueRefusedError);
    assert.match(error.message, /no GitHub repository/);
    return true;
  });
  assert.equal(created.length, 0);
  assert.deepEqual(await deps.store.list(issue.id), []);
});

test('an orphan from a crash between create and link is reused, not duplicated', async () => {
  const orphan: PushedGitHubIssue = {
    number: 9,
    url: 'https://github.com/acme/widgets/issues/9',
    body: buildPushIssueBody(issue)
  };
  const lookalike: PushedGitHubIssue = {
    number: 3,
    url: 'https://github.com/acme/widgets/issues/3',
    body: 'Paperclip issue: DAT-14281\n\nother'
  };
  const { deps, created } = createDeps({ findIssueByMarker: async () => [lookalike, orphan] });
  const result = await pushIssueToGitHub(deps, { paperclipIssueId: issue.id });

  assert.equal(created.length, 0);
  assert.equal(result.link.number, 9);
  assert.equal((await deps.store.list(issue.id)).length, 1);
});

test('a missing issue or identifier is refused', async () => {
  await assert.rejects(
    pushIssueToGitHub(createDeps({ getIssue: async () => null }).deps, { paperclipIssueId: 'x' }),
    PushIssueRefusedError
  );
  await assert.rejects(
    pushIssueToGitHub(createDeps({ getIssue: async () => ({ ...issue, identifier: '' }) }).deps, { paperclipIssueId: 'x' }),
    PushIssueRefusedError
  );
});

async function createPushHarness() {
  const plugin = (await import(new URL('../src/worker.ts?push-issue-test', import.meta.url).href)).default as typeof import('../src/worker.ts').default;
  const harness = createTestHarness({ manifest, config: { githubToken: 'ghp_test_token' } });
  await plugin.definition.setup(harness.ctx);
  // The harness issue store does not assign identifiers; Paperclip does.
  const getIssue = harness.ctx.issues.get.bind(harness.ctx.issues);
  harness.ctx.issues.get = async (issueId, companyId) => {
    const found = await getIssue(issueId, companyId);
    return found ? { ...found, identifier: 'DAT-1428' } : found;
  };
  return harness;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('push_issue_to_github is declared and works through the agent tool harness', async () => {
  assert.ok(manifest.tools?.some((tool) => tool.name === 'push_issue_to_github'));

  const harness = await createPushHarness();
  await harness.performAction('settings.saveRegistration', {
    mappings: [{
      id: 'mapping-a',
      repositoryUrl: 'acme/widgets',
      paperclipProjectName: 'Engineering',
      paperclipProjectId: 'project-1',
      companyId: 'company-1'
    }],
    syncState: { status: 'idle' }
  });
  const paperclipIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-1',
    title: 'Ship the push',
    description: 'Details.'
  });

  const created: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.pathname === '/search/issues') {
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    }
    if (url.pathname === '/repos/acme/widgets/issues' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      created.push(body);
      return jsonResponse({
        id: 9001,
        number: 77,
        title: body.title,
        body: body.body,
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/77',
        labels: [],
        comments: 0
      }, 201);
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  };

  try {
    const first = await harness.executeTool('push_issue_to_github', { paperclipIssueId: paperclipIssue.id }, { companyId: 'company-1' });
    assert.ok(!first.error, first.error);
    assert.equal((first.data as { created?: unknown }).created, true);
    assert.equal((first.data as { githubIssueNumber?: unknown }).githubIssueNumber, 77);
    assert.equal(created.length, 1);
    assert.match(String(created[0].body), /^Paperclip issue: DAT-1428$/m);

    const second = await harness.executeTool('push_issue_to_github', { paperclipIssueId: paperclipIssue.id }, { companyId: 'company-1' });
    assert.ok(!second.error, second.error);
    assert.equal((second.data as { created?: unknown }).created, false);
    assert.equal((second.data as { githubIssueUrl?: unknown }).githubIssueUrl, 'https://github.com/acme/widgets/issues/77');
    assert.equal(created.length, 1);

    const viaAction = await harness.performAction('issue.pushToGitHub', { companyId: 'company-1', issueId: paperclipIssue.id });
    assert.equal((viaAction as { created?: unknown }).created, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('push_issue_to_github on an unmapped project returns a descriptive error', async () => {
  const harness = await createPushHarness();
  const paperclipIssue = await harness.ctx.issues.create({
    companyId: 'company-1',
    projectId: 'project-unmapped',
    title: 'No repo here'
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('GitHub must not be called for an unmapped project.');
  };
  try {
    const result = await harness.executeTool('push_issue_to_github', { paperclipIssueId: paperclipIssue.id }, { companyId: 'company-1' });
    assert.match(result.error ?? '', /has no GitHub repository/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
