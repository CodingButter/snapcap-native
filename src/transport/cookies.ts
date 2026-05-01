/**
 * Cookie-jar-aware `fetch` wrapper used by the SDK's host-realm transport.
 *
 * @remarks
 * Builds a function with the same shape as `fetch`, but every request
 * automatically reads cookies from a tough-cookie `CookieJar` (or a
 * `CookieJarStore` wrapper) and persists Set-Cookie headers from the
 * response back into that jar.
 *
 * @internal
 */
import { CookieJar } from "tough-cookie";
import { nativeFetch } from "./native-fetch.ts";

/**
 * `fetch` init options accepted by {@link makeJarFetch}-built wrappers.
 *
 * Identical to `RequestInit`; aliased for clarity at call sites.
 *
 * @internal
 */
export type JarFetchOpts = RequestInit;

/**
 * Anything we can pull a tough-cookie `CookieJar` out of and (optionally)
 * persist on every Set-Cookie.
 *
 * @remarks
 * Lets {@link makeJarFetch} accept either a raw `CookieJar` (no persistence)
 * or a DataStore-backed `CookieJarStore` wrapper without leaking the storage
 * layer into transport code. The `flush` callback is invoked once per
 * response that wrote at least one cookie, so the underlying DataStore
 * survives a process restart.
 *
 * @internal
 */
export type JarLike = CookieJar | { jar: CookieJar; flush?: () => Promise<void> };

function pickJar(j: JarLike): CookieJar {
  return j instanceof CookieJar ? j : j.jar;
}

function pickFlush(j: JarLike): (() => Promise<void>) | undefined {
  // Bind `this` so the wrapper's call site (`await flush()`) doesn't lose
  // the `CookieJarStore` receiver — tough-cookie wrappers reference
  // `this.jar` / `this.store` inside `flush`.
  return j instanceof CookieJar ? undefined : j.flush?.bind(j);
}

/**
 * Build a cookie-jar-aware `fetch` wrapper.
 *
 * @remarks
 * The returned function:
 * - Pulls matching cookies out of the jar and sets the `Cookie` header.
 * - Sets a default `User-Agent` when one isn't supplied.
 * - After the response lands, reads every `Set-Cookie` line and persists it
 *   back into the jar (via `Headers.getSetCookie()`, which is the only way
 *   to access multiple Set-Cookies in fetch — `headers.get('set-cookie')`
 *   merges them on a single line and corrupts attributes).
 * - If passed a `CookieJarStore`-style wrapper (anything with a `flush()`
 *   method), flushes the underlying DataStore once per response so cookies
 *   survive process restarts.
 *
 * @param jarOrStore - A tough-cookie `CookieJar` OR a wrapper exposing
 *   `{ jar, flush? }` (e.g. `CookieJarStore`).
 * @param userAgent - Default `User-Agent` header to use when callers don't
 *   override it.
 * @returns A `(url, init?) => Promise<Response>` function that transparently
 *   threads cookies through every call.
 *
 * @internal
 */
export function makeJarFetch(
  jarOrStore: JarLike,
  userAgent: string,
): (url: string, init?: JarFetchOpts) => Promise<Response> {
  const jar = pickJar(jarOrStore);
  const flush = pickFlush(jarOrStore);
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const cookieHeader = await jar.getCookieString(url);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    const resp = await nativeFetch(url, { ...init, headers, redirect: init.redirect ?? "follow" });
    const setCookies =
      (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [];
    let wrote = false;
    for (const c of setCookies) {
      try {
        await jar.setCookie(c, url);
        wrote = true;
      } catch {
        // Some cookies (e.g. malformed or with unrecognized attributes)
        // can't be parsed by tough-cookie; safe to skip.
      }
    }
    if (wrote && flush) await flush();
    return resp;
  };
}

export { CookieJar };
