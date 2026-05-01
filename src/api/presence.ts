/**
 * Placeholder for the upcoming presence manager. No methods are exposed
 * yet; calls like `client.presence.setTyping(...)` will fail at compile
 * time.
 *
 * @see {@link SnapcapClient.presence}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the upcoming Presence domain manager.
 *
 * Held as {@link SnapcapClient.presence}. No methods are exposed yet —
 * any call site like `client.presence.setTyping(...)` is a TypeScript
 * compile error.
 *
 * @see {@link SnapcapClient}
 */
export class Presence {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
}
