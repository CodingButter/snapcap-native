/**
 * Web Storage API shim backed by a {@link DataStore}.
 *
 * @remarks
 * Implements the standard `Storage` interface (`getItem` / `setItem` /
 * `removeItem` / `clear` / `key` / `length`) on top of an underlying
 * {@link DataStore}. Each key is namespaced with a prefix so multiple shims
 * (`localStorage`, `sessionStorage`) can share one DataStore without
 * collision:
 *
 * ```text
 * localStorage.setItem("foo", "bar") → store.set("local_foo", utf8("bar"))
 * ```
 *
 * The Web Storage interface is synchronous, so this shim relies on a
 * synchronous read on the DataStore. {@link FileDataStore.getSync} provides
 * exactly that. For other DataStore impls without sync access, this shim
 * loads the prefix-matching keys at construction.
 *
 * @see {@link DataStore}
 * @see {@link FileDataStore}
 */
import type { DataStore } from "./data-store.ts";

type SyncCapable = DataStore & {
  getSync(key: string): Uint8Array | undefined;
  setSync(key: string, value: Uint8Array): void;
  keys(prefix?: string): string[];
};

/**
 * Web Storage API (`localStorage` / `sessionStorage`) implementation backed
 * by a {@link DataStore}.
 *
 * @remarks
 * Pass an instance into the sandbox via `new Sandbox({ dataStore, … })` so
 * the bundle's storage reads/writes route through your DataStore.
 *
 * @example
 * ```ts
 * import { StorageShim, FileDataStore } from "@snapcap/native";
 *
 * const store = new FileDataStore(".tmp/auth/auth.json");
 * const local = new StorageShim(store, "local_");
 * local.setItem("foo", "bar");
 * local.getItem("foo"); // "bar"
 * ```
 */
export class StorageShim implements Storage {
  /** Cache of values for the most recent reads — only used when underlying isn't sync. */
  private fallbackCache = new Map<string, string>();

  /**
   * @param store - Backing {@link DataStore}. Sync access (`getSync` /
   *   `setSync` / `keys`) is preferred so this shim can stay strictly
   *   synchronous; without it, async writes are fire-and-forget and reads
   *   serve from a pre-populated fallback cache.
   * @param prefix - Per-instance key prefix. Two shims sharing a DataStore
   *   should use distinct prefixes (e.g. `"local_"` and `"session_"`) so
   *   keys don't collide.
   */
  constructor(
    private store: DataStore,
    private prefix: string,
  ) {
    // Pre-populate fallback cache if store can list keys but isn't sync.
    if (typeof (store as Partial<SyncCapable>).keys === "function" &&
        typeof (store as Partial<SyncCapable>).getSync !== "function") {
      const keyList = (store as SyncCapable).keys(this.prefix);
      for (const fullKey of keyList) {
        // Will be filled lazily on first getItem
        this.fallbackCache.set(fullKey.slice(prefix.length), "");
      }
    }
  }

  private isSync(): boolean {
    return typeof (this.store as Partial<SyncCapable>).getSync === "function";
  }

  /** Number of stored keys under this shim's prefix. */
  get length(): number {
    if (this.isSync()) {
      return (this.store as SyncCapable).keys(this.prefix).length;
    }
    return this.fallbackCache.size;
  }

  /**
   * Web Storage `key(index)` — return the Nth key under this shim's prefix.
   *
   * @param index - Zero-based key index.
   * @returns The key (without the prefix) or `null` if `index` is out of range.
   */
  key(index: number): string | null {
    let keyList: string[];
    if (this.isSync()) {
      keyList = (this.store as SyncCapable).keys(this.prefix);
    } else {
      keyList = [...this.fallbackCache.keys()].map((k) => this.prefix + k);
    }
    const full = keyList[index];
    return full ? full.slice(this.prefix.length) : null;
  }

  /**
   * Web Storage `getItem(key)` — read the string value at `key`.
   *
   * @param key - The (un-prefixed) key.
   * @returns The decoded UTF-8 string, or `null` if the key is absent.
   */
  getItem(key: string): string | null {
    const fullKey = this.prefix + key;
    if (this.isSync()) {
      const bytes = (this.store as SyncCapable).getSync(fullKey);
      return bytes ? new TextDecoder().decode(bytes) : null;
    }
    return this.fallbackCache.get(key) ?? null;
  }

  /**
   * Web Storage `setItem(key, value)` — UTF-8 encode and store.
   *
   * @param key - The (un-prefixed) key.
   * @param value - The string value to store.
   */
  setItem(key: string, value: string): void {
    const fullKey = this.prefix + key;
    const bytes = new TextEncoder().encode(value);
    if (this.isSync()) {
      (this.store as SyncCapable).setSync(fullKey, bytes);
    } else {
      this.fallbackCache.set(key, value);
      void this.store.set(fullKey, bytes);
    }
  }

  /**
   * Web Storage `removeItem(key)` — delete the entry at `key`.
   *
   * @param key - The (un-prefixed) key to remove.
   */
  removeItem(key: string): void {
    const fullKey = this.prefix + key;
    this.fallbackCache.delete(key);
    void this.store.delete(fullKey);
  }

  /** Web Storage `clear()` — delete every entry under this shim's prefix. */
  clear(): void {
    if (this.isSync()) {
      const keyList = (this.store as SyncCapable).keys(this.prefix);
      for (const fullKey of keyList) void this.store.delete(fullKey);
    }
    this.fallbackCache.clear();
  }
}
