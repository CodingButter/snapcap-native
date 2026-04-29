/**
 * DataStore-backed CookieJar.
 *
 * Wraps tough-cookie's `CookieJar` so its serialized state lives under a
 * single DataStore key (default: `cookie_jar`). Loads at construction;
 * persists on every cookie change.
 *
 * Lets `fetch()` wrappers attach cookies automatically while everything
 * else (bearer, WASM state) shares the same backing DataStore.
 */
import { CookieJar } from "../transport/cookies.ts";
import type { DataStore } from "./data-store.ts";

export class CookieJarStore {
  readonly jar: CookieJar;

  private constructor(jar: CookieJar, private store: DataStore, private key: string) {
    this.jar = jar;
  }

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

  /** Persist the jar's current state back to the DataStore. */
  async flush(): Promise<void> {
    const serialized = await this.jar.serialize();
    const json = JSON.stringify(serialized);
    await this.store.set(this.key, new TextEncoder().encode(json));
  }
}
