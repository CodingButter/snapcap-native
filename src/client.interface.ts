/**
 * `ISnapcapClient` — the public contract {@link SnapcapClient} implements.
 *
 * Pulled into its own file so tests / mocks / consumer code can depend on
 * the interface without dragging in the full bundle bring-up machinery
 * `client.ts` brings with it.
 *
 * @remarks
 * Surface is intentionally minimal: auth verbs + the six per-domain
 * managers. Per-manager interfaces are designed when each migration
 * starts (per `feedback_registry_pattern.md`) — until then the manager
 * fields point at empty placeholder classes ({@link Messaging},
 * {@link Presence}, {@link Inbox}, {@link Media}, {@link Stories}) so
 * that calling, e.g., `client.messaging.send(...)` is a compile-time
 * error rather than a runtime one.
 */
import type { Friends } from "./api/friends.ts";
import type { Messaging } from "./api/messaging.ts";
import type { Presence } from "./api/presence.ts";
import type { Stories } from "./api/stories.ts";
import type { Inbox } from "./api/inbox.ts";
import type { Media } from "./api/media.ts";

/**
 * The public contract that {@link SnapcapClient} implements.
 *
 * Auth verbs + six per-domain managers. Consumers should code against
 * `ISnapcapClient` rather than the concrete class when writing tests,
 * mocks, or library code that accepts a client.
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

  // ── Domain managers ──────────────────────────────────────────────────
  // Placeholder classes for everything except `friends` (Phase 1A stub) —
  // per-domain interfaces designed when each migration starts.

  /**
   * Friend-graph manager — see {@link IFriendsManager} for the full
   * surface (mutations, reads, search, subscriptions).
   */
  readonly friends: Friends;

  /**
   * Placeholder for the future Messaging manager. No methods today —
   * `client.messaging.send(...)` is a compile-time error.
   */
  readonly messaging: Messaging;

  /**
   * Placeholder for the future Presence manager. No methods today.
   */
  readonly presence: Presence;

  /**
   * Placeholder for the future Stories manager. No methods today.
   */
  readonly stories: Stories;

  /**
   * Placeholder for the future Inbox manager. No methods today.
   */
  readonly inbox: Inbox;

  /**
   * Placeholder for the future Media manager. No methods today.
   */
  readonly media: Media;
}
