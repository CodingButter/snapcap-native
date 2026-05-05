/**
 * The public contract that {@link SnapcapClient} implements.
 *
 * Tests, mocks, and consumer code can depend on this interface without
 * pulling in the full bundle bring-up machinery in `client.ts`.
 */
import type { Friends } from "./api/friends/index.ts";
import type { Messaging } from "./api/messaging/index.ts";
import type { Presence } from "./api/presence.ts";
import type { Stories } from "./api/stories.ts";
import type { Media } from "./api/media.ts";
import type { PresenceStatus } from "./types.ts";

/**
 * The public contract that {@link SnapcapClient} implements.
 *
 * Surface is intentionally minimal: auth methods plus six per-domain
 * managers. Consumers should code against `ISnapcapClient` rather than
 * the concrete class when writing tests, mocks, or library code that
 * accepts a client.
 *
 * @see {@link SnapcapClient}
 * @see {@link IFriendsManager}
 */
export interface ISnapcapClient {
  // ── Auth surface ─────────────────────────────────────────────────────

  /**
   * Bring up the bundles, run warm-or-cold WebLogin, and populate the
   * Zustand auth slice.
   *
   * The first call does the heavy lifting (loads the accounts and chat
   * bundles, runs kameleon attestation, drives `WebLoginService` if no
   * cookies are cached); subsequent process boots with restored cookies
   * short-circuit through the warm SSO path (~1 redirect, ~100ms).
   *
   * @returns Resolves when the auth slice reports `LoggedIn`.
   * @throws If credentials are missing on cold-start (no cached cookies),
   * or if the server rejects the login attempt.
   *
   * @example
   * ```ts
   * const client = new SnapcapClient({ dataStore, browser, credentials });
   * await client.authenticate();
   * console.log(client.isAuthenticated()); // true
   * ```
   */
  authenticate(): Promise<void>;

  /**
   * Tear down the bundle-side auth state.
   *
   * Calls Snap's own `state.auth.logout` thunk — clears Zustand, fires
   * any subscribed teardown hooks, and (best-effort) revokes server-side.
   * Also deletes the persisted cookie jar entry from the DataStore.
   *
   * @param force - If `true`, force the logout even if the server-side
   * revoke call fails. Defaults to `false`.
   * @returns Resolves when local auth state has been cleared.
   */
  logout(force?: boolean): Promise<void>;

  /**
   * Refresh the bearer in-place via Snap's own `state.auth.refreshToken`.
   *
   * Requires the client to have been constructed with credentials — the
   * bundle's refresh path mints a fresh kameleon attestation bound to
   * the active identifier.
   *
   * @returns Resolves once the new bearer has been written back into the
   * Zustand auth slice.
   * @throws If the client was constructed without credentials.
   */
  refreshAuthToken(): Promise<void>;

  /**
   * Live read: `true` iff the Zustand auth slice currently reports
   * `LoggedIn`.
   *
   * Synchronous — backed by in-process state. Returns `false` before the
   * bundle is brought up (i.e. before {@link ISnapcapClient.authenticate}
   * has been called).
   */
  isAuthenticated(): boolean;

  /**
   * Live read: current SSO bearer string from the Zustand auth slice.
   *
   * @returns The bearer token (suitable for use as `Authorization: Bearer ...`).
   */
  getAuthToken(): string;

  /**
   * Live read: `state.auth.authState` enum value.
   *
   * @returns `0` = LoggedOut, `1` = LoggedIn, `2` = Processing,
   * `3` = MoreChallengesRequired.
   */
  getAuthState(): number;

  /**
   * Live read: the `hasEverLoggedIn` marker.
   *
   * Survives logout — useful for distinguishing a fresh install from a
   * signed-out returning user.
   */
  hasEverLoggedIn(): boolean;

  // ── Presence status ──────────────────────────────────────────────────

  /**
   * Set the global presence status for this client's session — the same
   * "I'm here" / "I'm away" slot the bundle's presence slice gates
   * outbound typing-pulse broadcasts on.
   *
   * @remarks
   * Synchronous; writes through `state.presence.setAwayState` on the
   * bundle's Zustand store, mapping the canonical SDK string to the
   * underlying numeric enum (chat module 46471's
   * `{Present: 0, Away: 1, AwaitingReactivate: 2}`).
   *
   * `"Present"` is the typical default — the chat-bundle loader patches
   * `document.hasFocus = () => true` so the slice initializes there at
   * factory time. Switching to `"Away"` causes the bundle to suppress
   * `broadcastTypingActivity` until the next `setStatus("Present")` call,
   * which is the right behaviour when a tenant is logically idle but the
   * SDK should keep the auth session live.
   *
   * Requires `client.authenticate()` to have completed first — the
   * presence slice doesn't exist on the bundle store until the chat
   * bundle has loaded.
   *
   * @param status - one of {@link PresenceStatus}
   * @throws if called before {@link ISnapcapClient.authenticate}, or if
   *   the bundle's presence slice / state-enum module shape has shifted.
   *
   * @example
   * ```ts
   * await client.authenticate();
   * client.setStatus("Away");           // suppress typing broadcasts
   * client.setStatus("Present");        // reopen the gate
   * ```
   *
   * @see {@link ISnapcapClient.getStatus}
   * @see {@link PresenceStatus}
   */
  setStatus(status: PresenceStatus): void;

  /**
   * Live read of the global presence status — same Zustand slot driven by
   * {@link ISnapcapClient.setStatus}, plus whatever the bundle itself
   * mutates in response to its own lifecycle events (focus / blur /
   * presence-service signals).
   *
   * @remarks
   * Synchronous; reads `state.presence.awayState` and maps the underlying
   * numeric enum value back to the canonical SDK string. If the slot
   * holds an unrecognized value (future-bundle drift), returns
   * `"AwaitingReactivate"` as the safest neutral fallback rather than
   * throwing.
   *
   * Requires `client.authenticate()` to have completed first.
   *
   * @returns the current {@link PresenceStatus}
   * @throws if called before {@link ISnapcapClient.authenticate}, or if
   *   the bundle's presence slice / state-enum module shape has shifted.
   *
   * @example
   * ```ts
   * await client.authenticate();
   * console.log(client.getStatus()); // "Present"
   * ```
   *
   * @see {@link ISnapcapClient.setStatus}
   * @see {@link PresenceStatus}
   */
  getStatus(): PresenceStatus;

  // ── Domain managers ──────────────────────────────────────────────────

  /**
   * Friend-graph manager — see {@link IFriendsManager} for the full
   * surface (mutations, reads, search, subscriptions).
   */
  readonly friends: Friends;

  /**
   * Messaging manager — inbox enumeration, raw envelope reads, live
   * decrypted message stream, and outbound presence (typing/viewing).
   * See {@link Messaging} for the surface.
   */
  readonly messaging: Messaging;

  /**
   * Placeholder for the upcoming Presence manager. No methods today.
   */
  readonly presence: Presence;

  /**
   * Placeholder for the upcoming Stories manager. No methods today.
   */
  readonly stories: Stories;

  /**
   * Placeholder for the upcoming Media manager. No methods today.
   */
  readonly media: Media;
}
