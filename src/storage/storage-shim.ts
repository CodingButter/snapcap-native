/**
 * Web Storage API shim backed by a DataStore.
 *
 * Implements the standard `Storage` interface (getItem/setItem/removeItem/
 * clear/key/length) on top of an underlying DataStore. Each key is
 * namespaced with a prefix so multiple shims (localStorage, sessionStorage)
 * can share one DataStore without collision:
 *   localStorage.setItem("foo", "bar") → store.set("local_foo", utf8("bar"))
 *
 * The Web Storage interface is synchronous, so this shim relies on a
 * synchronous read on the DataStore. `JsonFileDataStore.getSync` provides
 * exactly that. For other DataStore impls without sync access, this shim
 * loads the prefix-matching keys at construction.
 */
import type { DataStore } from "./data-store.ts";

type SyncCapable = DataStore & {
  getSync(key: string): Uint8Array | undefined;
  setSync(key: string, value: Uint8Array): void;
  keys(prefix?: string): string[];
};

export class StorageShim implements Storage {
  /** Cache of values for the most recent reads — only used when underlying isn't sync. */
  private fallbackCache = new Map<string, string>();

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

  get length(): number {
    if (this.isSync()) {
      return (this.store as SyncCapable).keys(this.prefix).length;
    }
    return this.fallbackCache.size;
  }

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

  getItem(key: string): string | null {
    const fullKey = this.prefix + key;
    if (this.isSync()) {
      const bytes = (this.store as SyncCapable).getSync(fullKey);
      return bytes ? new TextDecoder().decode(bytes) : null;
    }
    return this.fallbackCache.get(key) ?? null;
  }

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

  removeItem(key: string): void {
    const fullKey = this.prefix + key;
    this.fallbackCache.delete(key);
    void this.store.delete(fullKey);
  }

  clear(): void {
    if (this.isSync()) {
      const keyList = (this.store as SyncCapable).keys(this.prefix);
      for (const fullKey of keyList) void this.store.delete(fullKey);
    }
    this.fallbackCache.clear();
  }
}
