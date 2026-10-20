import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createInMemoryForgeLinkStore, forgeItemKey, type ForgeItemRef, type ForgeLink } from '../src/forge-link.ts';
import {
  syncTicketStatus,
  type ForgeItemState,
  type PaperclipIssueStatus,
  type StatusReturnDeps
} from '../src/status-return.ts';

const TICKET = 'issue-1';
const repo = { forge: 'github', host: 'github.com', repository: 'jaewilson07/example' } as const;
const issueLink: ForgeLink = { ...repo, number: 7, kind: 'issue', url: 'https://github.com/jaewilson07/example/issues/7' };
const prLink: ForgeLink = { ...repo, number: 8, kind: 'pull_request', url: 'https://github.com/jaewilson07/example/pull/8' };

async function setup(links: ForgeLink[], status: PaperclipIssueStatus, states: Record<number, ForgeItemState>) {
  const store = createInMemoryForgeLinkStore();
  for (const link of links) await store.put(TICKET, link);
  const world = { status, states: new Map<string, ForgeItemState>(), paperclipComments: [] as string[], forgeComments: [] as string[] };
  for (const link of links) world.states.set(forgeItemKey(link), states[link.number]);
  const deps: StatusReturnDeps = {
    links: store,
    describeTicket: () => 'DAT-1430',
    forge: {
      async getState(item: ForgeItemRef) {
        return world.states.get(forgeItemKey(item))!;
      },
      async closeIssueAsNotPlanned(item, comment) {
        world.states.set(forgeItemKey(item), { kind: 'issue', state: 'closed', reason: 'not_planned' });
        world.forgeComments.push(comment);
      }
    },
    paperclip: {
      async getStatus() {
        return world.status;
      },
      async setStatus(_id, next, comment) {
        world.status = next;
        world.paperclipComments.push(comment);
      }
    }
  };
  return { deps, world };
}

test('merged pull request with a deleted branch closes the ticket and names the pull request', async () => {
  const { deps, world } = await setup([prLink], 'in_review', { 8: { kind: 'pull_request', state: 'merged', branchDeleted: true } });
  const actions = await syncTicketStatus(deps, TICKET);
  assert.deepEqual(actions.map((a) => a.type), ['ticket_done']);
  assert.equal(world.status, 'done');
  assert.match(world.paperclipComments[0], /jaewilson07\/example#8/);
  assert.match(world.paperclipComments[0], /pull\/8/);
});

test('merged pull request with a surviving branch leaves the ticket open', async () => {
  const { deps, world } = await setup([prLink], 'in_review', { 8: { kind: 'pull_request', state: 'merged', branchDeleted: false } });
  assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
  assert.equal(world.status, 'in_review');
  assert.deepEqual(world.paperclipComments, []);
});

test('open and closed-unmerged pull requests leave the ticket open', async () => {
  for (const state of ['open', 'closed_unmerged'] as const) {
    const { deps, world } = await setup([prLink], 'in_progress', { 8: { kind: 'pull_request', state } });
    assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
    assert.equal(world.status, 'in_progress');
  }
});

test('issue closed as not planned cancels the ticket and does not push back to the forge', async () => {
  const { deps, world } = await setup([issueLink], 'todo', { 7: { kind: 'issue', state: 'closed', reason: 'not_planned' } });
  const actions = await syncTicketStatus(deps, TICKET);
  assert.deepEqual(actions.map((a) => a.type), ['ticket_cancelled']);
  assert.equal(world.status, 'cancelled');
  assert.match(world.paperclipComments[0], /not planned/);
  assert.deepEqual(world.forgeComments, []);
});

test('issue closed as completed leaves the ticket alone', async () => {
  const { deps, world } = await setup([issueLink], 'todo', { 7: { kind: 'issue', state: 'closed', reason: 'completed' } });
  assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
  assert.equal(world.status, 'todo');
});

test('cancelling a ticket closes the open issue as not planned with a comment pointing back', async () => {
  const { deps, world } = await setup([issueLink], 'cancelled', { 7: { kind: 'issue', state: 'open' } });
  const actions = await syncTicketStatus(deps, TICKET);
  assert.deepEqual(actions.map((a) => a.type), ['forge_issue_closed']);
  assert.deepEqual(world.states.get(forgeItemKey(issueLink)), { kind: 'issue', state: 'closed', reason: 'not_planned' });
  assert.match(world.forgeComments[0], /DAT-1430/);
});

test('cancelling a ticket does not touch a pull request or an already closed issue', async () => {
  const { deps, world } = await setup([issueLink, prLink], 'cancelled', {
    7: { kind: 'issue', state: 'closed', reason: 'completed' },
    8: { kind: 'pull_request', state: 'open' }
  });
  assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
  assert.deepEqual(world.forgeComments, []);
});

test('a ticket already done or cancelled is not moved by the forge', async () => {
  for (const status of ['done', 'cancelled'] as const) {
    const { deps, world } = await setup([prLink], status, { 8: { kind: 'pull_request', state: 'merged', branchDeleted: true } });
    assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
    assert.equal(world.status, status);
  }
});

test('merge with deleted branch outranks a not-planned issue on the same ticket', async () => {
  const { deps, world } = await setup([issueLink, prLink], 'in_review', {
    7: { kind: 'issue', state: 'closed', reason: 'not_planned' },
    8: { kind: 'pull_request', state: 'merged', branchDeleted: true }
  });
  await syncTicketStatus(deps, TICKET);
  assert.equal(world.status, 'done');
});

test('a ticket with no links is a no-op', async () => {
  const { deps } = await setup([], 'todo', {});
  assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
});

test('re-running the sync after each transition changes nothing', async () => {
  const cases: Array<[ForgeLink[], PaperclipIssueStatus, Record<number, ForgeItemState>]> = [
    [[prLink], 'in_review', { 8: { kind: 'pull_request', state: 'merged', branchDeleted: true } }],
    [[issueLink], 'todo', { 7: { kind: 'issue', state: 'closed', reason: 'not_planned' } }],
    [[issueLink], 'cancelled', { 7: { kind: 'issue', state: 'open' } }],
    [[prLink], 'in_review', { 8: { kind: 'pull_request', state: 'merged', branchDeleted: false } }]
  ];
  for (const [links, status, states] of cases) {
    const { deps, world } = await setup(links, status, states);
    await syncTicketStatus(deps, TICKET);
    const snapshot = JSON.stringify({ s: world.status, p: world.paperclipComments, f: world.forgeComments });
    assert.deepEqual(await syncTicketStatus(deps, TICKET), []);
    assert.equal(JSON.stringify({ s: world.status, p: world.paperclipComments, f: world.forgeComments }), snapshot);
  }
});
