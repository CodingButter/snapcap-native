/**
 * Shared tough-cookie `CookieJar` helper for sandbox shims.
 *
 * Why a shared helper: `document.cookie` (`shims/document-cookie.ts`) and
 * happy-dom's outgoing `fetch()` cookie container (`shims/cookie-container.ts`)
 * BOTH need to read/write the same jar — otherwise a value written via
 * `document.cookie = "..."` wouldn't appear on the next `fetch()`, and a
 * `Set-Cookie` from a fetch wouldn't be visible to JS-level reads. Both
 * shims also share the DataStore key (`cookie_jar`) with the host-realm
 * SDK code in `transport/cookies.ts`, so persistence is the *one* point
 * of synchronization across realms.
 *
 * This module owns the load/persist logic for the sandbox-side jar and
 * caches one jar instance per DataStore via a WeakMap, so repeated
 * installs in the same process don't fork the jar.
 *
 * Sync model — mirrors `shims/document-cookie.ts`'s prior behavior:
 *   - `getOrCreateJar(store)` hydrates synchronously from `getSync` if the
 *     DataStore exposes it, otherwise starts empty.
 *   - `persistJar(jar, store)` writes via `setSync` (preferred) or
 *     fire-and-forget `set` if the store is async-only.
 */
import { CookieJar } from "tough-cookie";
import type { DataStore } from "../storage/data-store.ts";

type SyncCapable = DataStore & {
  getSync(key: string): Uint8Array | undefined;
  setSync(key: string, value: Uint8Array): void;
};

export const COOKIE_JAR_KEY = "cookie_jar";

function isSyncStore(s: DataStore): s is SyncCapable {
  return (
    typeof (s as Partial<SyncCapable>).getSync === "function" &&
    typeof (s as Partial<SyncCapable>).setSync === "function"
  );
}

/** Per-DataStore jar cache so document-cookie + cookie-container share state. */
const JAR_CACHE = new WeakMap<DataStore, CookieJar>();

function loadJar(store: DataStore): CookieJar {
  if (!isSyncStore(store)) return new CookieJar();
  const bytes = store.getSync(COOKIE_JAR_KEY);
  if (!bytes || bytes.byteLength === 0) return new CookieJar();
  try {
    const json = new TextDecoder().decode(bytes);
    return CookieJar.deserializeSync(JSON.parse(json));
  } catch {
    // corrupt blob → start fresh; the host-realm fetch path uses the same
    // key so it'll overwrite once a real Set-Cookie lands.
    return new CookieJar();
  }
}

/**
 * Return the canonical `CookieJar` bound to this DataStore. Hydrates from
 * the store on first call; subsequent calls for the same store return the
 * exact same instance so multiple shims observe each other's writes
 * without going through serialization.
 */
export function getOrCreateJar(store: DataStore): CookieJar {
  let jar = JAR_CACHE.get(store);
  if (!jar) {
    jar = loadJar(store);
    JAR_CACHE.set(store, jar);
  }
  return jar;
}

/**
 * Serialize the jar and write it back to the DataStore. Caller invokes
 * this after any `setCookieSync` so other realms (host fetch, next process
 * boot) see the update. Silently no-ops on serialize failure — better to
 * keep running with an in-memory jar than to crash the sandbox.
 */
export function persistJar(jar: CookieJar, store: DataStore): void {
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
