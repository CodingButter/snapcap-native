/**
 * Placeholder for the upcoming stories manager. No methods are exposed
 * yet; calls like `client.stories.post(...)` will fail at compile time.
 *
 * @see {@link SnapcapClient.stories}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the upcoming Stories domain manager.
 *
 * Held as {@link SnapcapClient.stories}. No methods are exposed yet — any
 * call site like `client.stories.post(...)` is a TypeScript compile
 * error.
 *
 * @see {@link SnapcapClient}
 */
export class Stories {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
}
