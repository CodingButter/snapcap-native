/**
 * Main entry point for the SDK — see {@link SnapcapClient}.
 *
 * Constructed with a `DataStore` (required) plus optional cold-start
 * credentials. The DataStore is the persistence backbone: cookies,
 * bearer, and Snap's own sandbox storage (`local_*` / `session_*` /
 * `indexdb_*`) all live there under stable keys.
 *
 * @example
 * ```ts
 * const client = new SnapcapClient({ dataStore, browser, credentials });
 * await client.authenticate();
 * const friends = await client.friends.list();
 * ```
 *
 * @see {@link ISnapcapClient}
 * @see {@link SnapcapClientOpts}
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
import { Media } from "./api/media.ts";
import { Sandbox } from "./shims/sandbox.ts";
import type { DataStore } from "./storage/data-store.ts";
import type { ThrottleConfig, ThrottleGate } from "./transport/throttle.ts";
import { CookieJarStore } from "./storage/cookie-store.ts";
import { presenceSlice, presenceStateEnum } from "./bundle/register.ts";

// `Credentials`, `BrowserContext`, and `activeIdentifier` live in
// `./types.ts` so `api/auth.ts` can import them without forming a cycle
// with `client.ts`. Re-exported here so consumers can import the public
// types from either location.
export { activeIdentifier, type Credentials, type BrowserContext, type PresenceStatus } from "./types.ts";
import { activeIdentifier, type Credentials, type BrowserContext, type PresenceStatus } from "./types.ts";

/**
 * Public constructor options for {@link SnapcapClient}.
 *
 * @remarks
 * Four top-level concerns:
 *
 *   - `dataStore` — persistence backbone (cookies, bearer, sandbox storage).
 *   - `credentials` — login identity (username|email|phone + password).
 *     Optional for warm-start scenarios.
 *   - `browser` — browser-context fingerprint (UA required, others optional).
 *   - `throttle` — opt-in HTTP rate limiting (off by default).
 *
 * Credentials are NOT persisted to the DataStore — pass them again on
 * subsequent process boots if you want to be able to recover from a
 * session expiry.
 *
 * @see {@link SnapcapClient}
 * @see {@link DataStore}
 * @see {@link Credentials}
 * @see {@link BrowserContext}
 */
export type SnapcapClientOpts = {
  /**
   * Persistence backbone. Cookies, bearer, sandbox storage (`local_*` /
   * `session_*` / `indexdb_*`), and SDK-side blobs all land in this
   * store under stable keys.
   *
   * @see {@link DataStore}
   */
  dataStore: DataStore;
  /**
   * Login credentials. Optional — warm-start with cached cookies works
   * without credentials, but cold-login (no cookies) requires them.
   *
   * @see {@link Credentials} for shape (username | email | phone + password).
   */
  credentials?: Credentials;
  /**
   * Browser-context fingerprint. REQUIRED — `userAgent` inside is the
   * key field.
   *
   * @see {@link BrowserContext} for the full shape and the
   * fingerprint-hygiene rationale.
   */
  browser: BrowserContext;
  /**
   * Optional opt-in HTTP throttling. Default: no throttle
   * (browser-cadence, zero overhead). Two valid shapes:
   *
   *   1. {@link ThrottleConfig} — per-instance. Each `SnapcapClient`
   *      builds its own gate from this config. Fine for single-tenant
   *      or N=1-2 clients. Aggregate rate scales with N (each client
   *      throttles independently).
   *
   *   2. {@link ThrottleGate} — shared across instances. Build via
   *      `createSharedThrottle(config)` once, pass the same gate into
   *      every client. All clients coordinate, aggregate rate stays
   *      constant in N. Recommended for multi-tenant runners (N > 2).
   *
   * See `transport/throttle.ts` for the full picture, trade-offs, and
   * recommended rule sets (`RECOMMENDED_THROTTLE_RULES`).
   *
   * @example Per-instance:
   * ```ts
   * new SnapcapClient({
   *   dataStore, browser,
   *   throttle: { rules: RECOMMENDED_THROTTLE_RULES },
   * });
   * ```
   *
   * @example Shared across instances:
   * ```ts
   * const gate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
   * // pass `throttle: gate` into every SnapcapClient
   * new SnapcapClient({ dataStore, browser, throttle: gate });
   * ```
   */
  throttle?: ThrottleConfig | ThrottleGate;
};

/**
 * Concrete {@link ISnapcapClient} implementation — main SDK entry point.
 *
 * Each instance owns its own isolated `vm.Context` sandbox, Zustand
 * state, bearer token, and webpack runtime cache, so multiple clients
 * can coexist in one process without leaking state across tenants.
 *
 * Method-level documentation (auth verbs, manager fields) lives on
 * {@link ISnapcapClient}. The constructor and constructor options are
 * documented here.
 *
 * @see {@link ISnapcapClient}
 * @see {@link SnapcapClientOpts}
 */
export class SnapcapClient implements ISnapcapClient {
  private readonly opts: SnapcapClientOpts;
  private readonly userAgent: string;
  private _ctxPromise?: Promise<ClientContext>;

  /** {@inheritDoc ISnapcapClient.friends} */
  readonly friends: Friends;
  /** {@inheritDoc ISnapcapClient.messaging} */
  readonly messaging: Messaging;
  /** {@inheritDoc ISnapcapClient.presence} */
  readonly presence: Presence;
  /** {@inheritDoc ISnapcapClient.stories} */
  readonly stories: Stories;
  /** {@inheritDoc ISnapcapClient.media} */
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

  /**
   * Construct a new client.
   *
   * @param opts - Client options. See {@link SnapcapClientOpts}.
   * @throws If `opts.browser.userAgent` is missing — every consumer
   * defaulting to the same UA would itself become a snapcap fingerprint
   * signature.
   */
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
    this.media = new Media(getCtx);
  }

  /**
   * Lazy-built `ClientContext` — shared across every api call on this
   * client.
   */
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

  /** {@inheritDoc ISnapcapClient.authenticate} */
  async authenticate(): Promise<void> {
    if (!this.opts.credentials) {
      throw new Error(
        "authenticate requires opts.credentials in SnapcapClient constructor opts " +
        "(username|email|phone + password)",
      );
    }
    const ctx = await this._getCtx();
    await authBundle(ctx, { credentials: this.opts.credentials });

    // Warm + persist the friend-graph cache. Calling friends.list() routes
    // through Friends.snapshot() which writes the cache key to the
    // DataStore and seeds the diff-bridge baseline so any later
    // subscriber's first replay correctly identifies "new since last
    // session" mutuals/requests instead of treating every existing
    // entry as added. Best-effort: a friends fetch failure must not
    // poison the auth result — the auth slice is already populated
    // and consumers can retry friends.list() on demand.
    try {
      await this.friends.list();
    } catch (e) {
      // Surface for diagnostics but don't propagate.
      // eslint-disable-next-line no-console
      console.warn(
        `[snapcap] post-auth friends.list() failed (non-fatal): ${(e as Error).message ?? e}`,
      );
    }
  }

  /** {@inheritDoc ISnapcapClient.logout} */
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

  /** {@inheritDoc ISnapcapClient.refreshAuthToken} */
  async refreshAuthToken(): Promise<void> {
    if (!this.opts.credentials) {
      throw new Error("refreshAuthToken requires the client to be constructed with credentials");
    }
    const ctx = await this._getCtx();
    const id = activeIdentifier(this.opts.credentials);
    return refreshAuthTokenBundle(ctx, id.value);
  }

  /** {@inheritDoc ISnapcapClient.isAuthenticated} */
  isAuthenticated(): boolean {
    // No async — the slice is in-process state. Fall back to false if the
    // ctx hasn't been set up yet (which means `authenticate` was never
    // called and the chat bundle isn't loaded).
    if (!this._ctxPromise) return false;
    return isAuthenticatedBundle({ sandbox: this.sandbox } as ClientContext);
  }

  /** {@inheritDoc ISnapcapClient.getAuthToken} */
  getAuthToken(): string {
    return getAuthTokenBundle({ sandbox: this.sandbox } as ClientContext);
  }

  /** {@inheritDoc ISnapcapClient.getAuthState} */
  getAuthState(): number {
    return getAuthStateBundle({ sandbox: this.sandbox } as ClientContext);
  }

  /** {@inheritDoc ISnapcapClient.hasEverLoggedIn} */
  hasEverLoggedIn(): boolean {
    return hasEverLoggedInBundle({ sandbox: this.sandbox } as ClientContext);
  }

  // ── Presence status ────────────────────────────────────────────────

  /** {@inheritDoc ISnapcapClient.setStatus} */
  setStatus(status: PresenceStatus): void {
    const enumObj = presenceStateEnum(this.sandbox);
    // Map canonical SDK string → bundle's numeric enum value. The cast
    // through `unknown` is required because the slice typing intentionally
    // keeps `awayState` as `unknown` (forward-compat with future enum
    // shape drift).
    const value = enumObj[status];
    presenceSlice(this.sandbox).setAwayState(value as unknown);
  }

  /** {@inheritDoc ISnapcapClient.getStatus} */
  getStatus(): PresenceStatus {
    const enumObj = presenceStateEnum(this.sandbox);
    const raw = presenceSlice(this.sandbox).awayState;
    if (raw === enumObj.Present) return "Present";
    if (raw === enumObj.Away) return "Away";
    if (raw === enumObj.AwaitingReactivate) return "AwaitingReactivate";
    // Unknown future value — neutral fallback rather than throwing.
    // `AwaitingReactivate` is the safest neutral mapping (already a
    // transitional state) and matches the documented contract.
    return "AwaitingReactivate";
  }
}
