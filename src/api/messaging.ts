/**
 * Messaging manager — placeholder.
 *
 * Empty class until the Messaging migration starts. The per-domain
 * `IMessagingManager` interface (sendText / fetchMessages / onMessage / …)
 * is designed at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 *
 * `client.messaging.send(...)` is a TypeScript compile error today
 * (no method exists), not a runtime one.
 */
import type { ClientContext } from "./_context.ts";

export class Messaging {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Messaging migration starts)
}
