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
 * Reaching that instance from the outside requires private-field access
 * tricks. Instead we monkey-patch `CookieContainer.prototype.addCookies`
 * and `.getCookies` BEFORE the Window is constructed — every CookieContainer
 * created afterwards (i.e. the one happy-dom instantiates for our Window)
 * inherits the patched methods.
 *
 * Process-global scope: because we patch the prototype, ALL CookieContainer
 * instances in this Node process share the patched methods. This is fine
 * because the SDK runs a singleton Sandbox; if that ever changes, this
 * module needs revisiting (e.g. WeakMap from `this` to the bound jar).
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
import { Cookie, type CookieJar } from "tough-cookie";
import type { DataStore } from "../storage/data-store.ts";
import { getOrCreateJar, persistJar } from "./cookie-jar.ts";
import { Shim, type ShimContext } from "./types.ts";
import type { Sandbox } from "./sandbox.ts";

/** Module-singleton jar binding. Set by `installCookieContainer`. */
let activeJar: CookieJar | undefined;
let activeStore: DataStore | undefined;

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
 * directly. Production callers should use `installCookieContainer`.
 */
export class DataStoreCookieContainer {
  constructor(private readonly jar: CookieJar, private readonly store: DataStore) {}

  /** ICookieContainer.addCookies — translate each ICookie → tough-cookie + persist once. */
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
   * ICookieContainer.getCookies — happy-dom's contract:
   *   - `httpOnly === true` ⇒ return ONLY HttpOnly cookies.
   *   - `httpOnly === false` (the FetchRequestHeaderUtility caller) ⇒
   *     return ALL cookies, INCLUDING HttpOnly.
   * tough-cookie's `{ http: true }` means "HTTP context — HttpOnly visible";
   * `{ http: false }` means "non-HTTP (e.g. JS) context — HttpOnly hidden".
   * So the caller's `httpOnly === false` ⇒ tough-cookie `{ http: true }`.
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
 * Install the DataStore-backed cookie container by patching happy-dom's
 * `CookieContainer.prototype`. Must be called BEFORE the Window is
 * constructed so the (private) instance happy-dom news up inherits the
 * patched methods.
 *
 * Idempotent — repeated calls update the active jar binding without
 * re-patching the prototype.
 */
export function installCookieContainer(store: DataStore): void {
  activeJar = getOrCreateJar(store);
  activeStore = store;

  const proto = (CookieContainer as unknown as { prototype: Record<string, unknown> }).prototype;
  const marker = Symbol.for("snapcap.cookieContainerShim");
  if ((proto as Record<symbol, unknown>)[marker]) return;

  proto.addCookies = function (this: unknown, cookies: ICookie[]): void {
    if (!activeJar || !activeStore) return;
    const impl = new DataStoreCookieContainer(activeJar, activeStore);
    impl.addCookies(cookies);
  };
  proto.getCookies = function (this: unknown, url: URL | null, httpOnly: boolean): ICookie[] {
    if (!activeJar || !activeStore) return [];
    const impl = new DataStoreCookieContainer(activeJar, activeStore);
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
 * `Shim`-shaped wrapper around `installCookieContainer`. Consumes the
 * shared jar from `ShimContext` (populated by `getOrCreateJar` upstream
 * in the Sandbox constructor) and patches happy-dom's CookieContainer
 * prototype so the per-Window instance routes through it.
 *
 * MUST run before any other shim that needs cookies (DocumentCookieShim,
 * WebSocketShim) — see `./index.ts` for the canonical order.
 */
export class CookieContainerShim extends Shim {
  readonly name = "cookie-container";
  install(_sandbox: Sandbox, ctx: ShimContext): void {
    installCookieContainer(ctx.dataStore);
  }
}
