/**
 * Presence manager — placeholder.
 *
 * Empty class until the Presence migration starts. The per-domain
 * `IPresenceManager` interface (setTyping / setViewing / …) is designed
 * at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 *
 * @see {@link SnapcapClient.presence}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the future Presence domain manager.
 *
 * Held as {@link SnapcapClient.presence}. Exposes no methods today — the
 * formal `IPresenceManager` interface (setTyping / setViewing / …) is
 * designed when the Presence migration begins.
 *
 * @see {@link SnapcapClient}
 */
export class Presence {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Presence migration starts)
}
