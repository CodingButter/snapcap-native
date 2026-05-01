/**
 * Media manager — placeholder.
 *
 * Empty class until the Media migration starts. The per-domain
 * `IMediaManager` interface (sendImage / sendSnap / upload / …) is
 * designed at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 */
import type { ClientContext } from "./_context.ts";

export class Media {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Media migration starts)
}
