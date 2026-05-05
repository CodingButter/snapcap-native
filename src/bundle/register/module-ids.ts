/**
 * Webpack module ID constants — `wreq("<id>")` lookups.
 *
 * Each ID is one of Snap's chat-bundle webpack module identifiers,
 * confirmed by reading `vendor/snap-bundle/cf-st.sc-cdn.net/dw` with
 * byte-offset evidence. When Snap re-numbers a module, ONLY this file
 * needs updating — the consumer getters in this directory keep
 * resolving correctly.
 *
 * Each constant is an immutable string at module scope (per the
 * lint allowlist for module IDs).
 */

/** Bundle-native send entries (text / image / snap / mark-viewed / lifecycle / fetch). */
export const MOD_SENDS = "56639";

/**
 * Zustand store hosting the WHOLE chat-bundle state (auth + user + presence
 * + talk + more). Despite the historical name, module 94704 is not just the
 * auth slice — `getState()` returns every chat-side slice.
 */
export const MOD_CHAT_STORE = "94704";

/** Destinations builder + descriptor helpers (used by sendSnap / postStory). */
export const MOD_DESTINATIONS = "79028";

/** Story descriptor helpers (`R9` MY_STORY descriptor; `ge` server-destination conversion). */
export const MOD_STORY_DESC = "74762";

/** AtlasGw class (chat-bundle) — `SyncFriendData`, `GetSnapchatterPublicInfo`, etc. */
export const MOD_ATLAS_CLASS = "74052";

/** Host constants — `r5` is `https://web.snapchat.com`. */
export const MOD_HOST = "41359";

/**
 * Default-authed fetch factory — `s` is the bundle's same-origin POST
 * helper that attaches the bearer + cookies the way the SPA does.
 * Friends.search() routes through it for the `/search/search` POST.
 */
export const MOD_DEFAULT_AUTHED_FETCH = "34010";

/**
 * Presence-state enum module — exports `O` as
 * `{Present: 0, Away: 1, AwaitingReactivate: 2}`. The presence slice's
 * `awayState` slot stores one of these numeric values; the slice's own
 * `broadcastTypingActivity` is gated on `awayState === O.Present`.
 *
 * Confirmed at chat main byte ~4318612 — the factory body is a single
 * line: `n.d(t,{O:()=>i});var i={Present:0,Away:1,AwaitingReactivate:2}`.
 */
export const MOD_PRESENCE_STATE_ENUM = "46471";
