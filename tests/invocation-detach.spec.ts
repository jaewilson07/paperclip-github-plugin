import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

// Stands in for the SDK worker RPC host's invocationContextStorage: every worker->host call
// echoes the id of the store that is active in the calling async context, and the host rejects
// ids it no longer tracks ("missing, expired, or unknown invocation scope").
import { runDetachedFromInvocation } from '../src/invocation-detach.ts';

const invocationStorage = new AsyncLocalStorage<{ id: string }>();

test('background work started inside an invocation does not echo that invocation id', async () => {
  let background!: Promise<Array<string | undefined>>;

  await invocationStorage.run({ id: 'action-invocation' }, async () => {
    assert.equal(invocationStorage.getStore()?.id, 'action-invocation');
    background = runDetachedFromInvocation(async () => {
      const seen: Array<string | undefined> = [invocationStorage.getStore()?.id];
      // The host call settles (and the host drops the invocation) while the sync is still running.
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(invocationStorage.getStore()?.id);
      await Promise.resolve();
      seen.push(invocationStorage.getStore()?.id);
      return seen;
    });
  });

  assert.deepEqual(await background, [undefined, undefined, undefined]);
});

test('undetached background work keeps echoing the invocation id (the bug)', async () => {
  let background!: Promise<string | undefined>;
  await invocationStorage.run({ id: 'action-invocation' }, async () => {
    background = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return invocationStorage.getStore()?.id;
    })();
  });
  assert.equal(await background, 'action-invocation');
});
