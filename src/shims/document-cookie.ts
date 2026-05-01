/**
 * `document.cookie` shim — routes the sandbox's JS-level cookie reads/writes
 * through a tough-cookie `CookieJar` whose serialized state lives in the
 * SDK's `DataStore` (under the `cookie_jar` key, the same key used by
 * `transport/cookies.ts` for outgoing fetch).
 *
 * Why: bundle code that does `document.cookie = "..."` (or reads cookies
 * for fingerprinting) should hit the same jar that gRPC-Web requests use,
 * so values written by one path are visible to the other and both persist.
 *
 * Sync model — `Document.cookie` is a synchronous Web API but `DataStore`
 * is async. The shared `cookie-jar` helper caches the live jar in memory
 * and hydrates synchronously via `getSync` when available; writes go
 * through `setSync` (preferred) or fire-and-forget `set`.
 *
 * HttpOnly cookies are filtered out of the getter via tough-cookie's
 * `getCookiesSync(url, { http: false })` — JS-level access never sees them
 * per W3C spec.
 *
 * State sharing — the same jar instance backs `cookie-container.ts` (the
 * happy-dom outgoing-fetch container), so a `document.cookie = "..."`
 * write is immediately visible to the next `fetch()` and vice versa.
 */
import { Cookie } from "tough-cookie";
import type { DataStore } from "../storage/data-store.ts";
import { getOrCreateJar, persistJar } from "./cookie-jar.ts";
import type { Sandbox } from "./sandbox.ts";
import { Shim, type ShimContext } from "./types.ts";

/**
 * Override `document.cookie` on the sandbox's happy-dom Document with a
 * DataStore-backed accessor. Idempotent guard via a marker symbol so a
 * double-install doesn't re-wrap.
 */
export function installDocumentCookieShim(sandbox: Sandbox, store: DataStore): void {
  const doc = sandbox.document as object | undefined;
  if (!doc) return;

  const marker = Symbol.for("snapcap.documentCookieShim");
  const tagged = doc as Record<symbol, unknown>;
  if (tagged[marker]) return;

  const jar = getOrCreateJar(store);

  // Pull the current page URL lazily on each access so URL mutations
  // (history.pushState etc.) reflect into cookie path/domain matching.
  const currentUrl = (): string => {
    const w = sandbox.window as { location?: { href?: string } };
    return w.location?.href ?? "https://www.snapchat.com/web";
  };

  Object.defineProperty(doc, "cookie", {
    configurable: true,
    enumerable: true,
    get(): string {
      try {
        // `http: false` ⇒ exclude HttpOnly cookies, per W3C document.cookie.
        const cookies = jar.getCookiesSync(currentUrl(), { http: false });
        return cookies.map((c) => `${c.key}=${c.value}`).join("; ");
      } catch {
        return "";
      }
    },
    set(value: unknown): void {
      if (typeof value !== "string" || value.length === 0) return;
      let parsed: Cookie | undefined;
      try {
        parsed = Cookie.parse(value);
      } catch {
        return;
      }
      if (!parsed) return;
      try {
        jar.setCookieSync(parsed, currentUrl());
      } catch {
        return;
      }
      persistJar(jar, store);
    },
  });

  Object.defineProperty(doc, marker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/**
 * `Shim`-shaped wrapper around `installDocumentCookieShim`. Reads from
 * the shared jar populated by `CookieContainerShim` — must run after it.
 */
export class DocumentCookieShim extends Shim {
  readonly name = "document-cookie";
  install(sandbox: Sandbox, ctx: ShimContext): void {
    installDocumentCookieShim(sandbox, ctx.dataStore);
  }
}
