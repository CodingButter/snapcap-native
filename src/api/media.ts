/**
 * Media manager — placeholder.
 *
 * Empty class until the Media migration starts. The per-domain
 * `IMediaManager` interface (sendImage / sendSnap / upload / …) is
 * designed at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 *
 * @see {@link SnapcapClient.media}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the future Media domain manager.
 *
 * Held as {@link SnapcapClient.media}. Exposes no methods today — the
 * formal `IMediaManager` interface (sendImage / sendSnap / upload / …)
 * is designed when the Media migration begins.
 *
 * @see {@link SnapcapClient}
 */
export class Media {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Media migration starts)
}
