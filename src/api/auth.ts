/**
 * Bundle-driven auth orchestration.
 *
 * Tier-2 api file: composes the manager getters from
 * `../bundle/register.ts` (the "registry of Snap managers") into a
 * coherent end-user surface (`authenticate`, `logout`,
 * `refreshAuthToken`, …). Stateless — every exported function takes a
 * `ClientContext` first arg.
 *
 * @remarks
 * Architecture:
 *
 * `authenticate(ctx, {username, password})` is the single entry point.
 * It composes four steps:
 *
 *   1. `bringUp(ctx)` — load accounts + chat bundles (idempotent).
 *   2. `tryMintFromExistingCookies(ctx)` — warm path: if the jar holds
 *      a non-expired `__Host-sc-a-auth-session`, GET `/accounts/sso` to
 *      extract a fresh ticket and call `initializeAuth(...)`. Returns
 *      true on success; false otherwise (no cookies, or server
 *      rejected).
 *   3. `fullLogin(ctx, opts)` — cold path: drive the bundle's own
 *      2-step `WebLogin` (the same flow as
 *      `scripts/test-bundle-login.ts`).
 *   4. `mintAndInitialize(ctx)` — after `fullLogin` lands the
 *      auth-session cookies, mint a ticket via `mintBearer` (SDK-side
 *      redirect-follower role) and write the bearer into Zustand via
 *      `initializeAuth`.
 *
 * Auth state reads (`isAuthenticated`, `getAuthToken`, …) are direct
 * Zustand-slice peeks — no caching, the slice is the source of truth.
 *
 * Architectural roles (per `project_architecture_pivot.md`):
 *
 *   - The SDK plays "the browser": follows the SSO 303 redirect,
 *     extracts the ticket from the URL hash, hands it back to the
 *     bundle.
 *   - The bundle owns state + protocol: Zustand auth slice, refresh
 *     logic, logout.
 *
 * @internal
 */
import { CookieJar } from "tough-cookie";
import { ensureChatBundle } from "../bundle/chat-loader.ts";
import { getKameleon } from "../bundle/accounts-loader.ts";
import { makeJarFetch, type JarLike } from "../transport/cookies.ts";
import type { Sandbox } from "../shims/sandbox.ts";
import { getOrCreateJar } from "../shims/cookie-jar.ts";
import { authSlice, chatWreq, loginClient } from "../bundle/register.ts";
import type { UnaryFn, WebLoginRequest, WebLoginResponse } from "../bundle/types.ts";
import type { ClientContext } from "./_context.ts";
import { activeIdentifier, type Credentials } from "../types.ts";

export type { ClientContext } from "./_context.ts";

/**
 * `state.auth.authState` enum.
 *
 *   - `0` = LoggedOut
 *   - `1` = LoggedIn
 *   - `2` = Processing
 *   - `3` = MoreChallengesRequired
 *
 * @internal
 */
export type AuthState = 0 | 1 | 2 | 3;

/** Webpack module id for the WebLoginRequest/Response codec (accounts bundle). */
const MOD_WEB_LOGIN_PROTO = "29517"; // unused at runtime — kept for parity with login.ts; codecs are owned by submitLogin's ctor.
/** unaryFactory module id (accounts bundle). */
const MOD_UNARY_FACTORY = "98747";
/** SSO endpoint Snap's web client redirects through to mint a bearer. */
const SSO_URL =
  "https://accounts.snapchat.com/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb";

// ─── Public surface ───────────────────────────────────────────────────────

/**
 * One-call authentication: brings up the bundles, tries the warm path
 * (existing cookies → mint a fresh bearer), and falls back to a full
 * 2-step WebLogin if no cookies are present or the warm path fails.
 *
 * @param ctx - Per-instance client context.
 * @param opts - Login credentials.
 * @throws On cold-path failure (bad creds, network error, server reject).
 * The warm path's failure is silent (returns false → we proceed to
 * cold).
 *
 * @remarks
 * Consumer-visible state lives in the Zustand auth slice; read via
 * {@link isAuthenticated} / {@link getAuthToken} after this resolves.
 *
 * @internal
 */
export async function authenticate(
  ctx: ClientContext,
  opts: { credentials: Credentials },
): Promise<void> {
  await bringUp(ctx);
  if (await tryMintFromExistingCookies(ctx)) return;
  await fullLogin(ctx, opts);
  await mintAndInitialize(ctx);
}

/**
 * Tear down the bundle-side auth state.
 *
 * Calls Snap's own `state.auth.logout(force)` thunk — clears Zustand,
 * fires any subscribed teardown hooks, and (best-effort) revokes
 * server-side.
 *
 * @param ctx - Per-instance client context.
 * @param force - If `true`, force the logout even if server-side revoke
 * fails.
 *
 * @remarks
 * Does NOT delete cookie-jar entries from the DataStore; consumers who
 * want a "wipe everything" flow should also call
 * `dataStore.delete("cookie_jar")` (or equivalent).
 *
 * @internal
 */
export async function logout(ctx: ClientContext, force?: boolean): Promise<void> {
  await authSlice(ctx.sandbox).logout(force);
}

/**
 * Refresh the bearer in-place via Snap's own `state.auth.refreshToken`.
 *
 * @param ctx - Per-instance client context.
 * @param username - Active identifier the kameleon attestation will be
 * bound to (must match the username the slice's existing bearer was
 * minted for).
 * @param reason - Refresh reason label; defaults to `"page_load"`.
 *
 * @remarks
 * The bundle's refresh path requires:
 *
 *   - An existing bearer in the auth slice (chicken-and-egg with first
 *     mint — call {@link authenticate} first).
 *   - A fresh kameleon attestation (per `test-bundle-refresh.ts`
 *     findings — the slice's `refreshToken(reason, attestation)` second
 *     arg expects a token bound to the current username).
 *
 * The username binding for the attestation comes from the slice's
 * already-populated `authToken` payload — the SDK needs to know the
 * username at refresh time. Surfaced as the second arg here so callers
 * who track the username out-of-band can pass it in directly.
 *
 * @internal
 */
export async function refreshAuthToken(
  ctx: ClientContext,
  username: string,
  reason: string = "page_load",
): Promise<void> {
  const { ctx: kameleon } = await getKameleon(ctx.sandbox);
  const attestation = await kameleon.finalize(username);
  await authSlice(ctx.sandbox).refreshToken(reason, attestation);
}

/**
 * Live read: current SSO bearer string from the Zustand auth slice.
 *
 * @internal
 */
export function getAuthToken(ctx: ClientContext): string {
  return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authToken.token;
}

/**
 * Live read: current {@link AuthState} enum value.
 *
 * @internal
 */
export function getAuthState(ctx: ClientContext): AuthState {
  return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authState;
}

/**
 * Convenience: `true` iff the auth slice currently reports `LoggedIn`.
 *
 * @internal
 */
export function isAuthenticated(ctx: ClientContext): boolean {
  try {
    return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authState === 1;
  } catch {
    // Bundle not yet brought up → definitely not authenticated.
    return false;
  }
}

/**
 * Convenience: `true` iff the user has logged in at any point in this
 * realm's lifetime (survives logout).
 *
 * Useful for distinguishing a fresh install from a signed-out returning
 * user.
 *
 * @internal
 */
export function hasEverLoggedIn(ctx: ClientContext): boolean {
  try {
    return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).hasEverLoggedIn;
  } catch {
    return false;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Live shape of the auth slice as exposed by `authSlice(ctx.sandbox)`. The `AuthSlice`
 * type in `bundle/types.ts` only declares the methods (initialize, logout,
 * refreshToken, fetchToken); the live slice also carries these reactive
 * fields that we peek for the public-surface getters above.
 */
interface AuthSliceLive {
  authToken: { token: string; lastTokenRefresh: number | undefined };
  authState: AuthState;
  hasEverLoggedIn: boolean;
}

/**
 * Idempotent bundle bring-up. Loads kameleon (which loads the accounts
 * bundle as a side-effect — exposing `__SNAPCAP_LOGIN_CLIENT_IMPL`,
 * unaryFactory in module 98747, etc.), patches the sandbox `location`
 * so chat bundle's pathname guard accepts the realm, then loads the
 * chat bundle (which registers ~1488 modules including 94704, the
 * Zustand auth store).
 *
 * Per-context marker `_bundlesLoaded` short-circuits subsequent calls.
 */
async function bringUp(ctx: ClientContext): Promise<void> {
  if (ctx._bundlesLoaded) return;

  // 1. Boot kameleon — this loads the accounts bundle and runs the
  //    `__SNAPCAP_LOGIN_CLIENT_IMPL` source-patch as a side-effect.
  //    Sandbox is owned by SnapcapClient; ctx.sandbox provides isolation
  //    per-instance (kameleon Module is cached on the sandbox itself).
  await getKameleon(ctx.sandbox, { page: "www_login" });

  // 2. Patch sandbox `self.location.pathname` → "/web" so the chat
  //    bundle's module 13094 pathname guard ("Base path is not in the
  //    beginning of the pathname") doesn't throw at top-level eval.
  patchSandboxLocationToWeb(ctx);

  // 3. Load + prime chat bundle. `ensureChatBundle` includes priming of
  //    module 10409 (HY/JY/JZ codecs) and module 94704 (Zustand store
  //    M.getState) — both required for any register.ts getter to work.
  try {
    await ensureChatBundle(ctx.sandbox);
  } catch {
    // Chat bundle's main top-level may throw on browser-only init paths
    // (window.location reads, missing #__NEXT_DATA__, etc.). Module
    // factories are still registered before the throw — priming inside
    // ensureChatBundle handles the cyclic-dep rewire that makes them
    // callable through register.ts getters.
  }

  ctx._bundlesLoaded = true;
}

/**
 * Replace `sandbox.window.location` with a Proxy that fakes
 * `pathname=/web` and friends. The chat bundle's module 13094 reads
 * `self.location.pathname` at top-level eval and throws if it doesn't
 * start with "/web"; the accounts bundle leaves us on
 * "accounts.snapchat.com/v2/login" by default, so we proxy.
 *
 * Idempotent — re-calls overwrite with the same proxy.
 */
function patchSandboxLocationToWeb(ctx: ClientContext): void {
  const sandbox = ctx.sandbox;
  const prevLoc = sandbox.runInContext("self.location") as {
    href: string;
    pathname: string;
    origin?: string;
    protocol?: string;
    host?: string;
    hostname?: string;
  };
  // Already patched? `pathname` would already be "/web".
  try {
    if (prevLoc.pathname === "/web") return;
  } catch {
    // proxy may have a getter that throws on probe — fall through and re-wrap.
  }
  const patchedLoc = new Proxy(prevLoc, {
    get(target, prop) {
      if (prop === "pathname") return "/web";
      if (prop === "href") return "https://web.snapchat.com/web";
      if (prop === "origin") return "https://web.snapchat.com";
      if (prop === "host" || prop === "hostname") return "web.snapchat.com";
      return Reflect.get(target, prop);
    },
  });
  (sandbox.window as { location: unknown }).location = patchedLoc;
}

/**
 * Warm path: if the cookie jar already has a non-expired
 * `__Host-sc-a-auth-session`, try to mint a fresh bearer from it
 * (no password required). Returns true on success, false if the cookie
 * is missing, expired, or the SSO endpoint rejects it.
 *
 * Snap's session cookie is long-lived (~weeks); a successful warm path
 * costs ~1 SSO redirect (~100ms) vs cold's 2-step WebLogin + kameleon
 * attestation (~5s).
 */
async function tryMintFromExistingCookies(ctx: ClientContext): Promise<boolean> {
  // Read from the SHARED jar (the one the bundle's XHR-driven fetches
  // also write to via the cookie-container shim). `ctx.jar.jar` is the
  // `CookieJarStore` wrapper's own deserialized jar — created once at
  // ctx-init time, so it doesn't see writes the shim landed afterward.
  const jar = getOrCreateJar(ctx.dataStore);
  const cookies = await jar.getCookies("https://accounts.snapchat.com");
  const session = cookies.find((c) => c.key === "__Host-sc-a-auth-session");
  if (!session) return false;
  // Tough-cookie strips already-expired cookies; if it's still here it's
  // at least not past `Max-Age`. We let the SSO endpoint be the final
  // arbiter — it'll redirect without a ticket if the cookie's been
  // server-revoked.
  try {
    await mintAndInitialize(ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cold path: drive the bundle's own 2-step `WebLogin` via the
 * source-patched `WebLoginServiceClientImpl`. Mirrors the working flow
 * from `scripts/test-bundle-login.ts`.
 *
 * On success the auth-session cookies land in the jar via the XHR
 * shim's cookie-container patch.
 */
async function fullLogin(
  ctx: ClientContext,
  opts: { credentials: Credentials },
): Promise<void> {
  // Pull the active identifier (username | email | phone) — Snap's
  // WebLogin proto loginIdentifier is a oneof of the three. The
  // attestation also gets bound to whichever identifier the consumer
  // passed in (kameleon.finalize takes the identifier as its input).
  const id = activeIdentifier(opts.credentials);
  const { ctx: kameleon, wreq } = await getKameleon(ctx.sandbox, { page: "www_login" });

  // Force-eval module 13150 to fire the WebLoginServiceClientImpl
  // source-patch (the patch runs as a top-level statement inside the
  // module factory; nothing else imports it during bundle init).
  wreq("13150");

  // Build the unary fn via the bundle's unaryFactory (module 98747).
  // This wraps `_.grpc.unary` (improbable-eng) with metrics + auth-error
  // handling. Sandbox-realm Function — invoke against the bundle's
  // LoginClient ctor below.
  const factoryMod = wreq(MOD_UNARY_FACTORY) as { unaryFactory: Function };
  const unary = factoryMod.unaryFactory({
    onUnauthorizedError: () => {
      /* expected during logged-out 2-step; ignore */
    },
    metricsPrefix: "snapcap-auth",
    hostURL: "https://accounts.snapchat.com",
    userAgent: ctx.userAgent,
  }) as UnaryFn;

  // Construct the bundle's `WebLoginServiceClientImpl` once and reuse
  // for both 2-step calls.
  const LoginCtor = loginClient(ctx.sandbox);
  const login = new LoginCtor({ unary });
  const submitLogin = (req: WebLoginRequest): Promise<WebLoginResponse> => login.WebLogin(req);

  // Build the request envelopes using the sandbox's TextEncoder (so the
  // bundle's `instanceof Uint8Array` cross-realm checks pass).
  const TextEncoderCtor = ctx.sandbox.runInContext("TextEncoder") as typeof TextEncoder;
  const enc = new TextEncoderCtor();
  const attestation = await kameleon.finalize(id.value);

  const headerBrowserBase = {
    authenticationSessionPayload: new Uint8Array(),
    attestationPayload: enc.encode(attestation),
    arkoseToken: "",
    ssoClientId: "",
    continueParam:
      "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb",
    multiUser: false,
    captchaPayload: { provider: 0, payload: "", errorMessage: "" },
  };

  // Step 1: identifier + attestation.
  const r1 = await submitLogin({
    webLoginHeaderBrowser: headerBrowserBase,
    // Snap's WebLogin loginIdentifier is a ts-proto oneof keyed by `$case`.
    // Build the variant matching whichever identifier the consumer passed.
    loginIdentifier:
      id.type === "username" ? { $case: "username", username: id.value } :
      id.type === "email"    ? { $case: "email",    email:    id.value } :
                               { $case: "phone",    phone:    id.value },
  });
  const r1Payload = r1.payload as
    | { $case?: string; challengeData?: { challenge?: { $case?: string } } }
    | undefined;
  if (r1Payload?.$case === "errorData") {
    throw new Error(`WebLogin step 1 errorData: ${JSON.stringify(r1.payload)}`);
  }
  if (
    r1Payload?.$case !== "challengeData" ||
    r1Payload.challengeData?.challenge?.$case !== "passwordChallenge"
  ) {
    const innerCase = r1Payload?.challengeData?.challenge?.$case ?? "(none)";
    throw new Error(
      `WebLogin step 1 unexpected payload: outer=${r1Payload?.$case ?? "(none)"} inner=${innerCase}`,
    );
  }
  const sessionPayload = r1.authenticationSessionPayload as Uint8Array;

  // Step 2: password answer.
  const r2 = await submitLogin({
    webLoginHeaderBrowser: { ...headerBrowserBase, authenticationSessionPayload: sessionPayload },
    challengeAnswer: {
      challengeAnswer: {
        $case: "passwordChallengeAnswer",
        passwordChallengeAnswer: { password: opts.credentials.password },
      },
    },
  });
  const r2Payload = r2.payload as { $case?: string } | undefined;
  if (r2Payload?.$case === "errorData") {
    throw new Error(`WebLogin step 2 errorData: ${JSON.stringify(r2.payload)}`);
  }
  if (r2.statusCode !== 1) {
    throw new Error(`WebLogin step 2 statusCode=${r2.statusCode}, expected 1`);
  }

  // Verify the session cookie landed. The bundle's XHR-driven fetch
  // writes to the SHIM's jar (via `installCookieContainer`), not the
  // `CookieJarStore` wrapper's instance — read from the shared jar.
  const sharedJar = getOrCreateJar(ctx.dataStore);
  const authCookie = (await sharedJar.getCookies("https://accounts.snapchat.com")).find(
    (c) => c.key === "__Host-sc-a-auth-session",
  );
  if (!authCookie) {
    throw new Error("WebLogin succeeded protocol-wise but no __Host-sc-a-auth-session in jar");
  }
  // The shim's jar persists synchronously via `persistJar` on every write;
  // no flush needed here. ctx.jar.flush() would re-serialize the STALE
  // wrapper jar and overwrite what the shim landed.
}

/**
 * Mint a fresh ticket from the SSO endpoint (using the
 * already-authenticated session cookies in the jar) and hand it to
 * Snap's bundle-side `state.auth.initialize`. The bundle then writes the
 * bearer into Zustand: `authToken.token` populated, `authState=1`,
 * `hasEverLoggedIn=true`.
 *
 * SDK plays "the browser" here — Snap's `initialize` expects the page's
 * URL hash to contain `?ticket=<bearer>`, normally landed there by the
 * SSO 303 redirect. We do the redirect ourselves and synthesize the
 * `loc` argument.
 *
 * Throws if `mintBearer` can't extract a ticket from the SSO redirect
 * (cookie expired / server rejected) — `tryMintFromExistingCookies`
 * catches and returns false; cold-path callers let it propagate.
 */
async function mintAndInitialize(ctx: ClientContext): Promise<void> {
  // `mintBearer` runs SDK-side (host realm fetch) — it must use the SAME
  // jar the bundle's XHR shim writes to, otherwise the auth-session
  // cookies the bundle just landed aren't visible to the SSO redirect.
  // `getOrCreateJar` returns the WeakMap-cached jar shared by every shim
  // bound to this DataStore.
  const sharedJar = getOrCreateJar(ctx.dataStore);
  const { bearer } = await _mintTicketFromSSO({ jar: sharedJar, userAgent: ctx.userAgent });
  // Snap's `initialize` parses `loc.hash.slice(1)` then
  // `new URLSearchParams(...).get("ticket")` — slice(1) drops the leading
  // "#", so hash MUST start with "#" and the inner content must be
  // `ticket=<value>`.
  await authSlice(ctx.sandbox).initialize({
    hash: `#ticket=${encodeURIComponent(bearer)}`,
    search: "",
  });
}

// ─── SSO ticket mint (SDK-side redirect-follower) ─────────────────────────

const SSO_HOST = "https://accounts.snapchat.com";
const DEFAULT_SSO_CONTINUE =
  "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb";

type MintTicketOpts = {
  /**
   * Cookie source. Plain `CookieJar` or a DataStore-backed wrapper — the
   * GET to www.snapchat.com lands parent-domain cookies
   * (sc-a-nonce/_scid/sc_at) in the jar.
   */
  jar: JarLike;
  userAgent: string;
  /** continueParam used at login time. Must match for SSO to issue a ticket. */
  continueParam?: string;
};

type MintTicketResult = {
  bearer: string;
  /** Final landing URL after the SSO redirect — useful as referer for later calls. */
  landingUrl: string;
};

/**
 * Hit `accounts.snapchat.com/accounts/sso?...` with the current cookies
 * and pull the bearer ticket out of the 303 redirect's `Location` header.
 *
 * @param opts - SSO ticket-mint options.
 * @returns The bearer plus the final landing URL (useful as referer for
 * later calls).
 * @throws If neither GET nor POST against the SSO endpoint produces a
 * `Location` header containing `ticket=`.
 *
 * @remarks
 * Architectural role: the SDK plays "the browser" here — the bundle's
 * `state.auth.initialize(loc)` expects a URL hash containing
 * `?ticket=<bearer>`, normally landed there by Snap's own SSO 303
 * redirect. We follow the redirect ourselves and synthesize the `loc`
 * argument.
 *
 * Used by both warm path (cookies present → mint a fresh bearer), cold
 * path (full WebLogin → cookies seeded → mint via this), and the
 * legacy `client.ts` direct-RPC bearer chain (`refreshBearer` for 401
 * retry on tier-2 sends). Exported so the legacy chain can reach it
 * without re-pulling the helper into a separate module — the underscore
 * prefix flags this as an SDK-internal export, not a consumer surface.
 *
 * @internal
 */
export async function _mintTicketFromSSO(opts: MintTicketOpts): Promise<MintTicketResult> {
  const jarFetch = makeJarFetch(opts.jar, opts.userAgent);
  const ssoUrl = `${SSO_HOST}${opts.continueParam ?? DEFAULT_SSO_CONTINUE}`;

  // GET first — that's what the browser does after the password page submits.
  let resp = await jarFetch(ssoUrl, {
    method: "GET",
    headers: { referer: `${SSO_HOST}/v2/password` },
    redirect: "manual",
  });
  let location = resp.headers.get("location");
  let bearer = location ? extractTicket(location) : null;

  if (!bearer) {
    // Some flows want POST instead. Browser does POST when the SSO is part of
    // an OAuth-style consent screen. Worth trying as a fallback.
    resp = await jarFetch(ssoUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: `${SSO_HOST}/v2/password`,
      },
      body: "",
      redirect: "manual",
    });
    location = resp.headers.get("location");
    if (location) bearer = extractTicket(location);
  }

  if (!bearer || !location) {
    throw new Error(
      `couldn't extract bearer from SSO redirect (status=${resp.status}, location=${location?.slice(0, 100) ?? "(none)"})`,
    );
  }

  // Visit www.snapchat.com so the browser-side cookies (sc-a-nonce, _scid,
  // sc_at) get seeded into the jar. AtlasGw and friends require these
  // alongside the Bearer; otherwise the gRPC call returns 401.
  await jarFetch(location, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: `${SSO_HOST}/`,
    },
  });

  return { bearer, landingUrl: location };
}

function extractTicket(location: string): string | null {
  const m = location.match(/[#&]ticket=([^&#]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

// ─── Construction helper ──────────────────────────────────────────────────

/**
 * Build a `ClientContext` from the shape {@link SnapcapClient}
 * constructs at boot.
 *
 * Centralized here so `client.ts` doesn't have to know the layout of the
 * context.
 *
 * @remarks
 * The sandbox is required to be already installed (via `installShims`)
 * before this is called — `client.ts` does that eagerly in its
 * constructor.
 *
 * @internal
 */
export async function makeContext(opts: {
  sandbox: Sandbox;
  dataStore: ClientContext["dataStore"];
  jar: ClientContext["jar"];
  userAgent: string;
}): Promise<ClientContext> {
  return {
    sandbox: opts.sandbox,
    jar: opts.jar,
    dataStore: opts.dataStore,
    userAgent: opts.userAgent,
  };
}

// `CookieJar` is referenced in helper signatures via `ctx.jar.jar` reads;
// keep the import non-tree-shaken for clarity in case a future helper
// wants to construct a bare jar inline.
void CookieJar;
// Same for `MOD_WEB_LOGIN_PROTO` — declared above for documentation
// alignment with the legacy `src/auth/login.ts`; not currently
// referenced because the bundle's `WebLoginServiceClientImpl` ctor
// (returned by `loginClient(ctx.sandbox)`) owns the codec internally.
void MOD_WEB_LOGIN_PROTO;
