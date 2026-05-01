/**
 * Inbox manager — placeholder.
 *
 * Empty class until the Inbox migration starts. The per-domain
 * `IInboxManager` interface (fetchMessages / subscribe / …) is designed
 * at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 *
 * @see {@link SnapcapClient.inbox}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the future Inbox domain manager.
 *
 * Held as {@link SnapcapClient.inbox}. Exposes no methods today — the
 * formal `IInboxManager` interface (fetchMessages / subscribe / …) is
 * designed when the Inbox migration begins.
 *
 * @see {@link SnapcapClient}
 */
export class Inbox {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Inbox migration starts)
}
