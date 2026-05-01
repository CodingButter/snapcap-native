/**
 * Placeholder for the upcoming messaging manager. No methods are exposed
 * yet; calls like `client.messaging.send(...)` will fail at compile time.
 *
 * @see {@link SnapcapClient.messaging}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the upcoming Messaging domain manager.
 *
 * Held as {@link SnapcapClient.messaging}. No methods are exposed yet —
 * any call site like `client.messaging.send(...)` is a TypeScript compile
 * error.
 *
 * @see {@link SnapcapClient}
 */
export class Messaging {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
}
