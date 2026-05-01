/**
 * SnapcapClient — main entry point.
 *
 * Constructed with a `DataStore` (required) plus optional cold-start
 * credentials. The DataStore is the canonical persistence backbone:
 * cookies, bearer, and the Snap-bundle's own sandbox storage
 * (`local_*` / `session_*` / `indexdb_*`) all live there under stable
 * keys. Fidelius identity bootstrap is owned by the bundle, which
 * persists wrapped keys at `local_uds_uds.e2eeIdentityKey.shared`.
 *
 *   const client = new SnapcapClient({ dataStore, username, password });
 *   await client.authenticate();
 *   const friends = await client.friends.list();   // (Phase 1A: throws)
 *
 * `authenticate()` brings up the chat + accounts bundles and runs a
 * warm-or-cold WebLogin via Snap's own bundle code; on success the
 * Zustand auth slice holds the bearer (`getAuthToken()`) and the cookie
 * jar holds the long-lived `__Host-sc-a-auth-session`. Subsequent boots
 * with restored cookies short-circuit through the warm path.
 *
 * Surface is auth verbs + per-domain managers (`friends`, `messaging`,
 * `presence`, `stories`, `inbox`, `media`). Only `friends` carries a
 * Phase-1A stub; the other five are EMPTY placeholder classes — calling
 * `client.messaging.send(...)` is a TypeScript compile error today, not
 * a runtime one. Per-domain interfaces get designed when each migration
 * starts (per `feedback_registry_pattern.md`).
 */
import type { ISnapcapClient } from "./client.interface.ts";
import type { ClientContext } from "./api/_context.ts";
import {
  authenticate as authBundle,
  logout as logoutBundle,
  refreshAuthToken as refreshAuthTokenBundle,
  isAuthenticated as isAuthenticatedBundle,
  getAuthToken as getAuthTokenBundle,
  getAuthState as getAuthStateBundle,
  hasEverLoggedIn as hasEverLoggedInBundle,
  makeContext,
} from "./api/auth.ts";
import { Friends } from "./api/friends.ts";
import { Messaging } from "./api/messaging.ts";
import { Presence } from "./api/presence.ts";
import { Stories } from "./api/stories.ts";
import { Inbox } from "./api/inbox.ts";
import { Media } from "./api/media.ts";
import { installShims } from "./shims/runtime.ts";
import type { DataStore } from "./storage/data-store.ts";
import type { ThrottleConfig } from "./transport/throttle.ts";
import { CookieJarStore } from "./storage/cookie-store.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/**
 * Public constructor options for `SnapcapClient`.
 *
 * The DataStore is required and acts as the canonical persistence
 * backbone — cookies, bearer, and the Snap-bundle's own
 * `local_*`/`session_*`/`indexdb_*` sandbox storage all share it.
 *
 * `username`/`password` are only consulted on cold start (no restored
 * cookies). They are NOT persisted to the DataStore — pass them again
 * on subsequent process boots if you want to be able to recover from
 * a session expiry.
 */
export type SnapcapClientOpts = {
  dataStore: DataStore;
  username?: string;
  password?: string;
  /** UA fingerprint used at login. Persists with the cookies for consistency. */
  userAgent?: string;
  /**
   * Optional opt-in HTTP throttling. Default: no throttle (browser-cadence,
   * zero overhead). Pass `{ rules: RECOMMENDED_THROTTLE_RULES }` to enable
   * the recommended starter set, or supply your own per-pattern rules.
   */
  throttle?: ThrottleConfig;
};

export class SnapcapClient implements ISnapcapClient {
  private readonly opts: SnapcapClientOpts;
  private readonly userAgent: string;
  private _ctxPromise?: Promise<ClientContext>;

  readonly friends: Friends;
  readonly messaging: Messaging;
  readonly presence: Presence;
  readonly stories: Stories;
  readonly inbox: Inbox;
  readonly media: Media;

  constructor(opts: SnapcapClientOpts) {
    this.opts = opts;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

    // Seed the shim singleton with the consumer's DataStore eagerly.
    // `installShims` is first-call-wins — kameleon boot inside the
    // login flow will otherwise win the race with no dataStore set,
    // which means Snap-bundle local/session/indexdb writes go to
    // happy-dom's in-memory defaults instead of our store.
    installShims({
      url: "https://www.snapchat.com/web",
      dataStore: this.opts.dataStore,
      throttle: this.opts.throttle,
    });

    // Domain managers. Take a context provider (not the context itself)
    // so the field is available synchronously off `new SnapcapClient(...)`
    // while still routing through `_getCtx()` at call time. Per-domain
    // interfaces are designed when each migration starts; today only
    // `Friends` has a (stub) shape — the other five are empty placeholders.
    const getCtx = () => this._getCtx();
    this.friends = new Friends(getCtx);
    this.messaging = new Messaging(getCtx);
    this.presence = new Presence(getCtx);
    this.stories = new Stories(getCtx);
    this.inbox = new Inbox(getCtx);
    this.media = new Media(getCtx);
  }

  /** Lazy-built `ClientContext` — shared across every api call on this client. */
  private async _getCtx(): Promise<ClientContext> {
    if (!this._ctxPromise) {
      this._ctxPromise = (async () => {
        const jar = await CookieJarStore.create(this.opts.dataStore, "cookie_jar");
        return await makeContext({
          dataStore: this.opts.dataStore,
          jar,
          userAgent: this.userAgent,
        });
      })();
    }
    return this._ctxPromise;
  }

  // ── Auth surface ────────────────────────────────────────────────────

  async authenticate(): Promise<void> {
    if (!this.opts.username || !this.opts.password) {
      throw new Error(
        "authenticate requires username + password in SnapcapClient constructor opts",
      );
    }
    const ctx = await this._getCtx();
    return authBundle(ctx, { username: this.opts.username, password: this.opts.password });
  }

  async logout(force?: boolean): Promise<void> {
    if (this._ctxPromise) {
      try {
        const ctx = await this._getCtx();
        await logoutBundle(ctx, force);
      } catch {
        // Bundle may not be brought up yet — fall through to local cleanup.
      }
    }
    await this.opts.dataStore.delete("cookie_jar");
  }

  async refreshAuthToken(): Promise<void> {
    if (!this.opts.username) {
      throw new Error("refreshAuthToken requires the client to be constructed with credentials");
    }
    const ctx = await this._getCtx();
    return refreshAuthTokenBundle(ctx, this.opts.username);
  }

  /** Live read: true iff the Zustand auth slice currently reports `LoggedIn`. */
  isAuthenticated(): boolean {
    // No async — the slice is in-process state. Fall back to false if the
    // ctx hasn't been set up yet (which means `authenticate` was never
    // called and the chat bundle isn't loaded).
    if (!this._ctxPromise) return false;
    return isAuthenticatedBundle({} as ClientContext);
  }

  /** Live read: current SSO bearer string from the Zustand auth slice. */
  getAuthToken(): string {
    return getAuthTokenBundle({} as ClientContext);
  }

  /** Live read: AuthState enum (0=LoggedOut, 1=LoggedIn, 2=Processing, 3=MoreChallengesRequired). */
  getAuthState(): number {
    return getAuthStateBundle({} as ClientContext);
  }

  /** Live read: hasEverLoggedIn marker. Survives logout. */
  hasEverLoggedIn(): boolean {
    return hasEverLoggedInBundle({} as ClientContext);
  }
}
