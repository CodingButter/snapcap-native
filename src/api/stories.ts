/**
 * Stories manager — placeholder.
 *
 * Empty class until the Stories migration starts. The per-domain
 * `IStoriesManager` interface (post / fetchMyStory / …) is designed at
 * migration time, not pre-emptively — see `feedback_registry_pattern.md`.
 *
 * @remarks
 * The previous `postStory` / `postStoryFromBytes` registry-pattern
 * helpers were removed alongside `auth/messaging-session.ts`; the bundle
 * `sendSnap` + `myStoryDescriptors` verbs in `bundle/register.ts` are
 * the building blocks the Stories migration will compose on top of.
 *
 * @see {@link SnapcapClient.stories}
 */
import type { ClientContext } from "./_context.ts";

/**
 * Placeholder for the future Stories domain manager.
 *
 * Held as {@link SnapcapClient.stories}. Exposes no methods today — the
 * formal `IStoriesManager` interface (post / fetchMyStory / …) is
 * designed when the Stories migration begins.
 *
 * @see {@link SnapcapClient}
 */
export class Stories {
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}
  // (interface designed when Stories migration starts)
}
