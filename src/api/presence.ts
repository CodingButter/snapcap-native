/**
 * Presence manager — placeholder.
 *
 * Empty class until the Presence migration starts. The per-domain
 * `IPresenceManager` interface (setTyping / setViewing / …) is designed
 * at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 */
import type { ClientContext } from "./_context.ts";

export class Presence {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Presence migration starts)
}
