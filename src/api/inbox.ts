/**
 * Inbox manager — placeholder.
 *
 * Empty class until the Inbox migration starts. The per-domain
 * `IInboxManager` interface (fetchMessages / subscribe / …) is designed
 * at migration time, not pre-emptively — see
 * `feedback_registry_pattern.md`.
 */
import type { ClientContext } from "./_context.ts";

export class Inbox {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Inbox migration starts)
}
