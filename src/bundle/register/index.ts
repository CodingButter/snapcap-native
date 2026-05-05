/**
 * Bundle method registry — single source of truth for the Snap-bundle
 * managers and classes our SDK reaches. Each export is a late-bound
 * getter that takes a `Sandbox` and returns the live Snap manager (or
 * webpack module export); api files (`../../api/*.ts`) call methods on
 * it directly.
 *
 * Pattern: one `reach()` (or `reachModule()`) helper, one constant
 * mapper per entity, one zero-argument-after-sandbox getter per entity.
 * The getter returns the live class instance / module export — no shape
 * work, no UUID parsing, no compositions live here. The api layer owns
 * those.
 *
 * Sandbox-explicit: every export takes `sandbox: Sandbox` as its first
 * arg. This makes per-instance isolation possible — two `SnapcapClient`s
 * each pass their own Sandbox in, and the registry has zero shared
 * mutable state. The api layer threads `ctx.sandbox` through.
 *
 * If Snap renames a class, only one getter body changes; consumer api
 * code stays untouched.
 *
 * # Gap-fill conventions
 *
 * Two kinds of entries exist:
 *   - WIRED — constant mapper has a confirmed value; the getter resolves
 *     a real bundle entity at call time.
 *   - TODO — constant mapper is `undefined`; the getter throws an
 *     explicit "not yet mapped" error at call time. The TODO comment
 *     above the constant says exactly what to look for and where, so a
 *     follow-up hunt agent can fill in the value without re-deriving
 *     the search.
 *
 * Do NOT guess at __SNAPCAP_* names or webpack module IDs. If neither
 * has been confirmed by reading vendor/snap-bundle/cf-st.sc-cdn.net/dw
 * with byte-offset evidence, leave the constant `undefined` and write
 * a TODO.
 *
 * # File layout
 *
 * One sibling file per Snap-bundle domain. Constants live in
 * `patch-keys.ts` (source-patched `__SNAPCAP_*` keys) and `module-ids.ts`
 * (webpack module IDs). The `reach()` / `reachModule()` resolution
 * helpers live in `reach.ts`. Domain getters import from those.
 */

export { reach, reachModule } from "./reach.ts";
export type { Unsubscribe } from "./reach.ts";

export { friendActionClient, friendRequestsClient } from "./friends.ts";
export { authSlice, loginClient } from "./auth.ts";
export { chatRpc, chatStore, chatWreq } from "./chat.ts";
export { userSlice, userSliceFrom } from "./user.ts";
export { presenceSlice, presenceStateEnum } from "./presence.ts";
export type { PresenceStateEnum } from "./presence.ts";
export { messagingSends, messagingSlice } from "./messaging.ts";
export { destinationsModule, storyDescModule, uploadDelegate } from "./media.ts";
export { atlasClient, atlasGwClass, defaultAuthedFetch, hostModule } from "./host.ts";
export {
  sandboxRandomUUID,
  searchRequestCodec,
  searchResponseCodec,
  searchUsers,
  toVmU8,
} from "./search.ts";
export { storyManager, userInfoClient } from "./stories.ts";
export { subscribeUserSlice } from "./subscribe.ts";
