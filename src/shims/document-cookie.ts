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
 * is async. Mirroring `StorageShim`, the shim caches the live jar in
 * memory and:
 *   - hydrates the cache at construction via `getSync` if the DataStore
 *     supports it, otherwise starts empty (and warns if there *was* data
 *     to load),
 *   - on writes, updates the in-memory jar synchronously, then either
 *     `setSync`s (preferred) or fire-and-forget `set`s the new bytes back.
 *
 * HttpOnly cookies are filtered out of the getter via tough-cookie's
 * `getCookiesSync(url, { http: false })` — JS-level access never sees them
 * per W3C spec.
 */
import { Cookie, CookieJar } from "tough-cookie";
import type { DataStore } from "../storage/data-store.ts";
import type { Sandbox } from "./sandbox.ts";

type SyncCapable = DataStore & {
  getSync(key: string): Uint8Array | undefined;
  setSync(key: string, value: Uint8Array): void;
};

const COOKIE_JAR_KEY = "cookie_jar";

function isSyncStore(s: DataStore): s is SyncCapable {
  return (
    typeof (s as Partial<SyncCapable>).getSync === "function" &&
    typeof (s as Partial<SyncCapable>).setSync === "function"
  );
}

function loadJar(store: DataStore): CookieJar {
  if (!isSyncStore(store)) return new CookieJar();
  const bytes = store.getSync(COOKIE_JAR_KEY);
  if (!bytes || bytes.byteLength === 0) return new CookieJar();
  try {
    const json = new TextDecoder().decode(bytes);
    return CookieJar.deserializeSync(JSON.parse(json));
  } catch {
    // corrupt blob → start fresh; the outgoing-fetch path uses the same
    // key so it'll overwrite once a real Set-Cookie lands.
    return new CookieJar();
  }
}

function persistJar(jar: CookieJar, store: DataStore): void {
  let bytes: Uint8Array;
  try {
    const serialized = jar.serializeSync();
    if (!serialized) return;
    bytes = new TextEncoder().encode(JSON.stringify(serialized));
  } catch {
    return;
  }
  if (isSyncStore(store)) {
    store.setSync(COOKIE_JAR_KEY, bytes);
  } else {
    void store.set(COOKIE_JAR_KEY, bytes);
  }
}

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

  const jar = loadJar(store);

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
