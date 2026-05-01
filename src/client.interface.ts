/**
 * `ISnapcapClient` — the public contract `SnapcapClient` implements.
 *
 * Pulled into its own file so tests / mocks / consumer code can depend on
 * the interface without dragging in the full bundle bring-up machinery
 * `client.ts` brings with it.
 *
 * Surface is intentionally minimal: auth verbs + the six per-domain
 * managers. Per-manager interfaces are designed when each migration starts
 * (per `feedback_registry_pattern.md`) — until then the manager fields
 * point at empty placeholder classes (`Messaging`, `Presence`, `Inbox`,
 * `Media`, `Stories`) so that calling, e.g., `client.messaging.send(...)`
 * is a compile-time error rather than a runtime one.
 */
import type { Friends } from "./api/friends.ts";
import type { Messaging } from "./api/messaging.ts";
import type { Presence } from "./api/presence.ts";
import type { Stories } from "./api/stories.ts";
import type { Inbox } from "./api/inbox.ts";
import type { Media } from "./api/media.ts";

export interface ISnapcapClient {
  // ── Auth surface ─────────────────────────────────────────────────────
  /** Bring up the bundles, run warm-or-cold WebLogin, populate the auth slice. */
  authenticate(): Promise<void>;
  /** Tear down the bundle-side auth state. */
  logout(force?: boolean): Promise<void>;
  /** Refresh the bearer in-place via Snap's own `state.auth.refreshToken`. */
  refreshAuthToken(): Promise<void>;
  /** Live read: true iff the Zustand auth slice currently reports `LoggedIn`. */
  isAuthenticated(): boolean;
  /** Live read: current SSO bearer string from the Zustand auth slice. */
  getAuthToken(): string;
  /** Live read: AuthState enum (0=LoggedOut, 1=LoggedIn, 2=Processing, 3=MoreChallengesRequired). */
  getAuthState(): number;
  /** Live read: hasEverLoggedIn marker. Survives logout. */
  hasEverLoggedIn(): boolean;

  // ── Domain managers ──────────────────────────────────────────────────
  // Placeholder classes for everything except `friends` (Phase 1A stub) —
  // per-domain interfaces designed when each migration starts.
  readonly friends: Friends;
  readonly messaging: Messaging;
  readonly presence: Presence;
  readonly stories: Stories;
  readonly inbox: Inbox;
  readonly media: Media;
}
