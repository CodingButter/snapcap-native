import { CookieJar } from "tough-cookie";
import { nativeFetch } from "./native-fetch.ts";

export type JarFetchOpts = RequestInit;

/**
 * Cookie-jar-aware fetch wrapper.
 *
 * - Pulls matching cookies out of the jar and sets the `Cookie` header.
 * - Sets a default User-Agent when one isn't supplied.
 * - After the response lands, reads every Set-Cookie line and persists it
 *   back into the jar (via `Headers.getSetCookie()`, which is the only way
 *   to access multiple Set-Cookies in fetch — `headers.get('set-cookie')`
 *   merges them on a single line and corrupts attributes).
 */
export function makeJarFetch(jar: CookieJar, userAgent: string): (url: string, init?: JarFetchOpts) => Promise<Response> {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const cookieHeader = await jar.getCookieString(url);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    const resp = await nativeFetch(url, { ...init, headers, redirect: init.redirect ?? "follow" });
    const setCookies =
      (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [];
    for (const c of setCookies) {
      try {
        await jar.setCookie(c, url);
      } catch {
        // Some cookies (e.g. malformed or with unrecognized attributes)
        // can't be parsed by tough-cookie; safe to skip.
      }
    }
    return resp;
  };
}

export { CookieJar };
