/**
 * happy-dom `CookieContainer` override — routes the cookies that happy-dom
 * attaches to outgoing `fetch()` calls through a DataStore-backed
 * tough-cookie `CookieJar`, the same jar the `document.cookie` shim and
 * the host-realm `transport/cookies.ts` fetch wrapper use.
 *
 * Why: happy-dom's default `CookieContainer` (see
 * `node_modules/happy-dom/lib/cookie/CookieContainer.js`) keeps cookies
 * in an in-memory `#cookies` array — anything the bundle writes from JS
 * (or that arrives via `Set-Cookie` from happy-dom-driven fetches) lives
 * only inside that Window. We want those cookies to land in OUR jar so:
 *   1. The bundle's natural `fetch()` carries our SSO bearer/cookies.
 *   2. JS-level `document.cookie` writes flow into the same jar.
 *   3. The host-realm gRPC-Web client (which reads `cookie_jar` directly)
 *      sees a unified state.
 *
 * Architectural principle (the SDK-wide invariant): override at I/O
 * boundaries (storage, cookies). Never reimplement Snap's protocols.
 * The bundle is the driver; we just provide a substrate that persists.
 *
 * Implementation — happy-dom's `BrowserContext` constructs a fresh
 * `CookieContainer` instance each time a Window is created, and stores
 * it behind private fields (`#browserFrame.page.context.cookieContainer`).
 * We:
 *   1. Patch `CookieContainer.prototype.addCookies` / `.getCookies` ONCE
 *      per process. The patched methods dispatch via a
 *      `WeakMap<CookieContainer, { jar, store }>` keyed by the calling
 *      `this`, so each Sandbox's CookieContainer routes through its OWN
 *      jar — no shared module-level state.
 *   2. After the Window is constructed, walk the (private but reachable)
 *      `WindowBrowserContext` API to grab the per-Window CookieContainer
 *      and bind it in the WeakMap. CookieContainers without a binding
 *      fall through to no-op behaviour.
 *
 * Multi-instance: two Sandboxes have two Windows → two CookieContainers,
 * each bound to its own jar in the WeakMap. The patched prototype is
 * shared (process-global), but the per-instance state is keyed by `this`,
 * so isolation is preserved.
 *
 * happy-dom's outgoing-fetch path that reads us back:
 *   `lib/fetch/utilities/FetchRequestHeaderUtility.js:89`
 *     `options.browserFrame.page.context.cookieContainer.getCookies(originURL, false)`
 *   The `false` means "include HttpOnly", which maps to tough-cookie's
 *   `{ http: true }` (the http=true axis = "this is an HTTP API, so
 *   HttpOnly cookies are visible").
 *
 * happy-dom only consumes `key` and `value` from each returned ICookie
 * (see `CookieStringUtility.cookiesToString`), but we still populate the
 * other fields defensively in case future happy-dom versions inspect
 * more attributes.
 */
import CookieContainer from "happy-dom/lib/cookie/CookieContainer.js";
import type ICookie from "happy-dom/lib/cookie/ICookie.js";
import CookieSameSiteEnum from "happy-dom/lib/cookie/enums/CookieSameSiteEnum.js";
import WindowBrowserContext from "happy-dom/lib/window/WindowBrowserContext.js";
import { Cookie, type CookieJar } from "tough-cookie";
import type { DataStore } from "../storage/data-store.ts";
import { getOrCreateJar, persistJar } from "./cookie-jar.ts";
import { Shim, type ShimContext } from "./types.ts";
import type { Sandbox } from "./sandbox.ts";

/**
 * Per-CookieContainer binding. Looked up by the patched prototype methods
 * via `this` so each Sandbox's CookieContainer dispatches through its own
 * jar — zero module-level mutable state.
 */
type CookieBinding = { jar: CookieJar; store: DataStore };
const BINDINGS = new WeakMap<object, CookieBinding>(); // MULTI-INSTANCE-SAFE: keyed by per-Sandbox-Window CookieContainer; each Sandbox dispatches through its own jar via `this` lookup

/** Convert tough-cookie's lowercase sameSite (or undefined) → happy-dom enum. */
function tcSameSiteToHd(s: string | undefined): CookieSameSiteEnum {
  if (s === "strict") return CookieSameSiteEnum.strict;
  if (s === "lax") return CookieSameSiteEnum.lax;
  return CookieSameSiteEnum.none;
}

/** Convert happy-dom's enum → tough-cookie's lowercase string (or undefined). */
function hdSameSiteToTc(s: CookieSameSiteEnum | string | undefined): string | undefined {
  if (s === CookieSameSiteEnum.strict || s === "Strict") return "strict";
  if (s === CookieSameSiteEnum.lax || s === "Lax") return "lax";
  if (s === CookieSameSiteEnum.none || s === "None") return "none";
  return undefined;
}

/** Pick a synthetic origin URL for an ICookie when the caller didn't supply one. */
function fallbackOriginURL(domain: string, path: string, secure: boolean): URL {
  const host = domain.startsWith(".") ? domain.slice(1) : domain || "www.snapchat.com";
  const proto = secure ? "https" : "http";
  return new URL(`${proto}://${host}${path || "/"}`);
}

/**
 * happy-dom-shaped CookieContainer that delegates to a tough-cookie jar.
 * Exported for tests / advanced consumers that want to drive the container
 * directly. Production callers should use {@link installCookieContainer}.
 *
 * @internal
 */
export class DataStoreCookieContainer {
  constructor(private readonly jar: CookieJar, private readonly store: DataStore) {}

  /**
   * `ICookieContainer.addCookies` — translate each ICookie to tough-cookie
   * and persist once at the end of the batch.
   *
   * @internal
   * @param cookies - happy-dom-shaped cookie array
   */
  addCookies(cookies: ICookie[]): void {
    if (!Array.isArray(cookies) || cookies.length === 0) return;
    let mutated = false;
    for (const c of cookies) {
      if (!c || !c.key) continue;
      const originURL: URL =
        c.originURL instanceof URL
          ? c.originURL
          : fallbackOriginURL(c.domain ?? "", c.path ?? "/", !!c.secure);
      const tcCookie = new Cookie({
        key: c.key,
        value: c.value ?? "",
        domain: c.domain ? c.domain.replace(/^\./, "") : undefined,
        path: c.path || "/",
        expires: c.expires instanceof Date ? c.expires : undefined,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: hdSameSiteToTc(c.sameSite),
      });
      try {
        this.jar.setCookieSync(tcCookie, originURL.href);
        mutated = true;
      } catch {
        // ignore individual cookie rejections (public-suffix, expired, etc.)
      }
    }
    if (mutated) persistJar(this.jar, this.store);
  }

  /**
   * `ICookieContainer.getCookies` — happy-dom's contract:
   *
   * - `httpOnly === true` returns ONLY HttpOnly cookies.
   * - `httpOnly === false` (the FetchRequestHeaderUtility caller) returns
   *   ALL cookies, INCLUDING HttpOnly.
   *
   * tough-cookie's `{ http: true }` means "HTTP context — HttpOnly visible";
   * `{ http: false }` means "non-HTTP (e.g. JS) context — HttpOnly hidden".
   * So the caller's `httpOnly === false` maps to tough-cookie `{ http: true }`.
   *
   * @internal
   * @param url - request URL (for path/domain matching); `null` falls back
   *   to a synthetic snapchat.com URL
   * @param httpOnly - happy-dom semantic: true for "HttpOnly only"
   * @returns happy-dom `ICookie[]` projection of the matching jar entries
   */
  getCookies(url: URL | null, httpOnly: boolean): ICookie[] {
    const target = url?.href ?? "https://www.snapchat.com/";
    let tcCookies: Cookie[] = [];
    try {
      tcCookies = this.jar.getCookiesSync(target, { http: true });
    } catch {
      return [];
    }
    const out: ICookie[] = [];
    for (const c of tcCookies) {
      // happy-dom semantics: `httpOnly === true` filters to HttpOnly-only.
      if (httpOnly === true && !c.httpOnly) continue;
      const domain = c.domain ?? "";
      const path = c.path ?? "/";
      out.push({
        key: c.key,
        value: c.value ?? "",
        // tough-cookie strips `originURL`; reconstruct from cookie attrs.
        originURL: fallbackOriginURL(domain, path, !!c.secure),
        domain,
        path,
        expires: c.expires instanceof Date ? c.expires : null,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: tcSameSiteToHd(c.sameSite),
      });
    }
    return out;
  }
}

/**
 * Install the prototype patch on happy-dom's `CookieContainer.prototype`
 * (process-global, idempotent). The patched methods dispatch via the
 * per-instance {@link BINDINGS} WeakMap — calling
 * {@link bindCookieContainer} after a Window is constructed is what
 * actually wires THIS Sandbox's CookieContainer through the DataStore.
 *
 * Splitting "patch the prototype" from "bind a specific instance" is
 * what makes multi-Sandbox isolation work: the patch is shared but
 * stateless; the (jar, store) lives on the per-CookieContainer binding.
 *
 * @internal
 */
export function installCookieContainer(_store: DataStore): void {
  const proto = (CookieContainer as unknown as { prototype: Record<string, unknown> }).prototype;
  const marker = Symbol.for("snapcap.cookieContainerShim");
  if ((proto as Record<symbol, unknown>)[marker]) return;

  proto.addCookies = function (this: object, cookies: ICookie[]): void {
    const binding = BINDINGS.get(this);
    if (!binding) return;
    const impl = new DataStoreCookieContainer(binding.jar, binding.store);
    impl.addCookies(cookies);
  };
  proto.getCookies = function (this: object, url: URL | null, httpOnly: boolean): ICookie[] {
    const binding = BINDINGS.get(this);
    if (!binding) return [];
    const impl = new DataStoreCookieContainer(binding.jar, binding.store);
    return impl.getCookies(url, httpOnly);
  };

  Object.defineProperty(proto, marker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/**
 * Bind a Sandbox's per-Window `CookieContainer` to its `(jar, store)`. The
 * per-Window instance is reached via happy-dom's `WindowBrowserContext`
 * helper (`window → browserFrame → page → context → cookieContainer`).
 *
 * Idempotent: re-binding the same CookieContainer just overwrites the
 * (jar, store) entry — fine because both come from the same DataStore.
 *
 * @internal
 * @param hdWindow - happy-dom Window (Sandbox.hdWindow); we reach its
 *   per-instance CookieContainer through the BrowserContext chain
 * @param jar - tough-cookie jar this Sandbox's cookies route through
 * @param store - DataStore backing the jar (for persistence on writes)
 * @returns true if binding succeeded; false if the BrowserContext chain
 *   was unreachable (e.g. detached Window) — in that case happy-dom's
 *   in-memory CookieContainer behaviour applies and our patch no-ops
 */
export function bindCookieContainer(
  hdWindow: object,
  jar: CookieJar,
  store: DataStore,
): boolean {
  // WindowBrowserContext is happy-dom's documented (but not top-level
  // exported) shim for reaching the per-Window BrowserContext without
  // exposing the Browser to scripts. See
  // `node_modules/happy-dom/lib/window/WindowBrowserContext.js`.
  const wbc = new (WindowBrowserContext as unknown as new (w: object) => {
    getBrowserContext(): { cookieContainer?: object } | null;
  })(hdWindow);
  const ctx = wbc.getBrowserContext();
  const container = ctx?.cookieContainer;
  if (!container) return false;
  BINDINGS.set(container, { jar, store });
  return true;
}

/**
 * `Shim`-shaped wrapper. Patches the CookieContainer prototype (idempotent)
 * and binds THIS Sandbox's per-Window CookieContainer to the shared jar
 * from {@link ShimContext}.
 *
 * MUST run before any other shim that needs cookies ({@link DocumentCookieShim},
 * {@link WebSocketShim}) — see `./index.ts` for the canonical order.
 *
 * @internal
 */
export class CookieContainerShim extends Shim {
  /** @internal */
  readonly name = "cookie-container";
  /** @internal */
  install(sandbox: Sandbox, ctx: ShimContext): void {
    installCookieContainer(ctx.dataStore);
    bindCookieContainer(sandbox.hdWindow, ctx.jar, ctx.dataStore);
  }
}
