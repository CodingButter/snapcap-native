/**
 * Messaging manager — placeholder.
 *
 * Empty class until the Messaging migration starts. The per-domain
 * `IMessagingManager` interface (sendText / fetchMessages / onMessage / …)
 * is designed at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 *
 * @remarks
 * `client.messaging.send(...)` is a TypeScript compile error today
 * (no method exists), not a runtime one.
 *
 * @see {@link SnapcapClient.messaging}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the future Messaging domain manager.
 *
 * Held as {@link SnapcapClient.messaging}. Currently exposes no methods —
 * any call site like `client.messaging.send(...)` is a TypeScript compile
 * error. Methods (and the formal `IMessagingManager` interface) are added
 * when the Messaging migration begins.
 *
 * @see {@link SnapcapClient}
 */
export class Messaging {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Messaging migration starts)
}
