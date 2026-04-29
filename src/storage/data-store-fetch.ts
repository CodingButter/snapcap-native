/**
 * Fetch wrapper that auto-attaches cookies + bearer from a DataStore.
 *
 * Reads cookies from a CookieJarStore for the request URL and (for
 * configured domains) reads the bearer from the AuthStore — adding
 * `Cookie` and `Authorization: Bearer …` headers to outgoing requests.
 * Strips Origin/Referer/Accept-Language/Mcs-Cof-Ids-Bin to match what
 * Snap's Fidelius gateway expects (those headers trigger 401 there).
 *
 * Behaviour modeled after `src/transport/cookies.ts:makeJarFetch` plus
 * the `stripOriginReferer` transform from `src/api/fidelius.ts`.
 */
import { nativeFetch } from "../transport/native-fetch.ts";
import type { CookieJarStore } from "./cookie-store.ts";

export type DataStoreFetchOpts = {
  /** Strip these headers regardless of who set them. Default: Snap's Fidelius blocklist. */
  stripHeaders?: string[];
};

const DEFAULT_STRIP = ["origin", "referer", "accept-language", "mcs-cof-ids-bin"];

/**
 * Fetch wrapper that auto-attaches cookies from a CookieJarStore and
 * persists Set-Cookie responses back to it. That's it — bearer, user-agent,
 * and other auth state live in shimmed browser primitives (sessionStorage
 * etc.) where Snap's bundle reads them, not as their own store entries.
 */
export function makeFetchWithStore(
  cookieStore: CookieJarStore,
  opts: DataStoreFetchOpts = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const stripHeaders = (opts.stripHeaders ?? DEFAULT_STRIP).map((h) => h.toLowerCase());

  return async function fetchWithStore(url, init = {}) {
    const headers = new Headers(init.headers);

    const cookieStr = await cookieStore.jar.getCookieString(url);
    if (cookieStr && !headers.has("cookie")) headers.set("cookie", cookieStr);

    for (const h of stripHeaders) headers.delete(h);

    const resp = await nativeFetch(url, { ...init, headers });

    const setCookies = (resp.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (() => {
        const v = resp.headers.get("set-cookie");
        return v ? [v] : [];
      })();
    if (setCookies.length > 0) {
      for (const c of setCookies) await cookieStore.jar.setCookie(c, url).catch(() => {});
      await cookieStore.flush();
    }

    return resp;
  };
}
