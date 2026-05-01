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
import { Sandbox } from "./shims/sandbox.ts";
import type { DataStore } from "./storage/data-store.ts";
import type { ThrottleConfig, ThrottleGate } from "./transport/throttle.ts";
import { CookieJarStore } from "./storage/cookie-store.ts";

// `Credentials`, `BrowserContext`, and `activeIdentifier` live in
// `./types.ts` so `api/auth.ts` can import them without forming a cycle
// with `client.ts`. Re-exported here so consumers can import the public
// types from either location.
export { activeIdentifier, type Credentials, type BrowserContext } from "./types.ts";
import { activeIdentifier, type Credentials, type BrowserContext } from "./types.ts";

/**
 * Public constructor options for `SnapcapClient`.
 *
 * Four top-level concerns:
 *   - `dataStore`     — persistence backbone (cookies, bearer, sandbox storage).
 *   - `credentials`   — login identity (username|email|phone + password).
 *                       Optional for warm-start scenarios.
 *   - `browser`       — browser-context fingerprint (UA required, others optional).
 *   - `throttle`      — opt-in HTTP rate limiting (off by default).
 *
 * Credentials are NOT persisted to the DataStore — pass them again on
 * subsequent process boots if you want to be able to recover from a
 * session expiry.
 */
export type SnapcapClientOpts = {
  dataStore: DataStore;
  /**
   * Login credentials. Optional — warm-start with cached cookies works
   * without credentials, but cold-login (no cookies) requires them.
   * See `Credentials` type for shape (username | email | phone + password).
   */
  credentials?: Credentials;
  /**
   * Browser-context fingerprint. REQUIRED — `userAgent` inside is the
   * key field. See `BrowserContext` for the full shape and the
   * fingerprint-hygiene rationale.
   */
  browser: BrowserContext;
  /**
   * Optional opt-in HTTP throttling. Default: no throttle (browser-cadence,
   * zero overhead). Two valid shapes:
   *
   *   1. `ThrottleConfig` — per-instance. Each `SnapcapClient` builds its
   *      own gate from this config. Fine for single-tenant or N=1-2 clients.
   *      Aggregate rate scales with N (each client throttles independently).
   *
   *   2. `ThrottleGate` — shared across instances. Build via
   *      `createSharedThrottle(config)` once, pass the same gate into every
   *      client. All clients coordinate, aggregate rate stays constant in N.
   *      Recommended for multi-tenant runners (N > 2).
   *
   * See `transport/throttle.ts` for the full picture, trade-offs, and
   * recommended rule sets (`RECOMMENDED_THROTTLE_RULES`).
   *
   * @example Per-instance:
   *   throttle: { rules: RECOMMENDED_THROTTLE_RULES }
   * @example Shared across instances:
   *   const gate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
   *   // pass `throttle: gate` into every SnapcapClient
   */
  throttle?: ThrottleConfig | ThrottleGate;
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

  /**
   * Per-instance Sandbox. Each `SnapcapClient` owns its own `vm.Context`,
   * happy-dom Window, shimmed I/O layer, and per-Sandbox bring-up caches
   * (kameleon boot, chat bundle eval, chat WASM Module, throttle gate).
   *
   * This is what makes multi-instance possible: two `SnapcapClient`s
   * never share Zustand state, bearer tokens, or webpack runtime caches.
   * They're isolated at the V8 vm.Context boundary.
   */
  private readonly sandbox: Sandbox;

  constructor(opts: SnapcapClientOpts) {
    if (!opts.browser?.userAgent) {
      throw new Error(
        "SnapcapClient requires opts.browser.userAgent — pass a recent realistic UA. " +
        "If every consumer defaults to the same UA, it becomes a snapcap fingerprint signature.",
      );
    }
    this.opts = opts;
    this.userAgent = opts.browser.userAgent;

    // Construct a per-instance Sandbox directly — no `installShims`
    // singleton dance. The Sandbox owns the vm.Context + happy-dom
    // Window + shim I/O layer + bring-up caches; another SnapcapClient
    // gets its own fresh Sandbox with zero shared state.
    this.sandbox = new Sandbox({
      url: "https://www.snapchat.com/web",
      userAgent: opts.browser.userAgent,
      viewportWidth: opts.browser.viewport?.width,
      viewportHeight: opts.browser.viewport?.height,
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
          sandbox: this.sandbox,
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
    if (!this.opts.credentials) {
      throw new Error(
        "authenticate requires opts.credentials in SnapcapClient constructor opts " +
        "(username|email|phone + password)",
      );
    }
    const ctx = await this._getCtx();
    return authBundle(ctx, { credentials: this.opts.credentials });
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
    if (!this.opts.credentials) {
      throw new Error("refreshAuthToken requires the client to be constructed with credentials");
    }
    const ctx = await this._getCtx();
    const id = activeIdentifier(this.opts.credentials);
    return refreshAuthTokenBundle(ctx, id.value);
  }

  /** Live read: true iff the Zustand auth slice currently reports `LoggedIn`. */
  isAuthenticated(): boolean {
    // No async — the slice is in-process state. Fall back to false if the
    // ctx hasn't been set up yet (which means `authenticate` was never
    // called and the chat bundle isn't loaded).
    if (!this._ctxPromise) return false;
    return isAuthenticatedBundle({ sandbox: this.sandbox } as ClientContext);
  }

  /** Live read: current SSO bearer string from the Zustand auth slice. */
  getAuthToken(): string {
    return getAuthTokenBundle({ sandbox: this.sandbox } as ClientContext);
  }

  /** Live read: AuthState enum (0=LoggedOut, 1=LoggedIn, 2=Processing, 3=MoreChallengesRequired). */
  getAuthState(): number {
    return getAuthStateBundle({ sandbox: this.sandbox } as ClientContext);
  }

  /** Live read: hasEverLoggedIn marker. Survives logout. */
  hasEverLoggedIn(): boolean {
    return hasEverLoggedInBundle({ sandbox: this.sandbox } as ClientContext);
  }
}
