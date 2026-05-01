/**
 * Placeholder for the upcoming inbox manager. No methods are exposed yet;
 * calls like `client.inbox.fetchMessages(...)` will fail at compile time.
 *
 * @see {@link SnapcapClient.inbox}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the upcoming Inbox domain manager.
 *
 * Held as {@link SnapcapClient.inbox}. No methods are exposed yet — any
 * call site like `client.inbox.fetchMessages(...)` is a TypeScript
 * compile error.
 *
 * @see {@link SnapcapClient}
 */
export class Inbox {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
}
