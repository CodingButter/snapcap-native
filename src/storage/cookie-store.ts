/**
 * DataStore-backed CookieJar.
 *
 * @remarks
 * Wraps tough-cookie's `CookieJar` (re-exported from
 * `transport/cookies.ts`) so its serialized state lives under a
 * single {@link DataStore} key (default: `"cookie_jar"`). Loads at
 * construction; persists on every cookie change via {@link CookieJarStore.flush}.
 *
 * Lets the host-realm `fetch` wrapper attach cookies automatically while
 * everything else (bearer, WASM state) shares the same backing
 * {@link DataStore}.
 *
 * @see {@link DataStore}
 */
import { CookieJar } from "../transport/cookies.ts";
import type { DataStore } from "./data-store.ts";

/**
 * DataStore-backed wrapper around a tough-cookie `CookieJar`.
 *
 * @remarks
 * Construct via the static {@link CookieJarStore.create} factory — the ctor
 * is private so a fully-rehydrated jar is guaranteed before first use.
 *
 * @example
 * ```ts
 * import { CookieJarStore, FileDataStore } from "@snapcap/native";
 *
 * const store = new FileDataStore(".tmp/auth/auth.json");
 * const jarStore = await CookieJarStore.create(store);
 * // jarStore.jar is a tough-cookie CookieJar; pass to your fetch wrapper.
 * await jarStore.flush();
 * ```
 */
export class CookieJarStore {
  /** The underlying tough-cookie `CookieJar`. */
  readonly jar: CookieJar;

  private constructor(jar: CookieJar, private store: DataStore, private key: string) {
    this.jar = jar;
  }

  /**
   * Build a new `CookieJarStore`, rehydrating the jar from the
   * {@link DataStore} if a prior serialization exists at `key`.
   *
   * @param store - The {@link DataStore} backing the persisted cookie state.
   * @param key - Storage key under which the serialized jar lives. Defaults
   *   to `"cookie_jar"`.
   * @returns A ready-to-use `CookieJarStore` whose `.jar` is fully populated
   *   from prior state (if any).
   */
  static async create(store: DataStore, key = "cookie_jar"): Promise<CookieJarStore> {
    const bytes = await store.get(key);
    let jar: CookieJar;
    if (bytes && bytes.byteLength > 0) {
      const json = new TextDecoder().decode(bytes);
      jar = await CookieJar.deserialize(JSON.parse(json) as never);
    } else {
      jar = new CookieJar();
    }
    return new CookieJarStore(jar, store, key);
  }

  /**
   * Persist the jar's current state back to the {@link DataStore}.
   *
   * @remarks
   * Called automatically by `makeJarFetch` after any response that yielded a
   * Set-Cookie. Call directly if you mutate the jar by other means
   * (`jar.setCookie()` from your own code).
   */
  async flush(): Promise<void> {
    const serialized = await this.jar.serialize();
    const json = JSON.stringify(serialized);
    await this.store.set(this.key, new TextEncoder().encode(json));
  }
}
