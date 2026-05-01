/**
 * Placeholder for the upcoming media manager. No methods are exposed yet;
 * calls like `client.media.upload(...)` will fail at compile time.
 *
 * @see {@link SnapcapClient.media}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the upcoming Media domain manager.
 *
 * Held as {@link SnapcapClient.media}. No methods are exposed yet — any
 * call site like `client.media.upload(...)` is a TypeScript compile
 * error.
 *
 * @see {@link SnapcapClient}
 */
export class Media {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
}
