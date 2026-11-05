import { AsyncResource } from 'node:async_hooks';

/**
 * The Paperclip worker RPC host runs every host-issued call (performAction, runJob, ...) inside an
 * AsyncLocalStorage store and stamps the store's invocation id on each worker->host request made
 * from that async context. The host drops that invocation when the call settles (for actions:
 * after the 30s default RPC timeout, or when the action returns), and rejects later requests that
 * still carry the id with "missing, expired, or unknown invocation scope".
 *
 * A sync can outlive the action that started it, so its work must not inherit the action's
 * context. Requests without an invocation id take the host's proactive path, which authorizes a
 * single explicit company the plugin is configured for.
 *
 * This resource is created when the module loads, outside any invocation, so running `fn` in its
 * scope restores that clean (invocation-free) async context for `fn` and everything it awaits.
 */
const cleanContext = new AsyncResource('github-sync.detached');

export function runDetachedFromInvocation<T>(fn: () => T): T {
  return cleanContext.runInAsyncScope(fn);
}
