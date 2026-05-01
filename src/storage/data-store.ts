/**
 * Persistent key-value storage abstraction for the SDK.
 *
 * @remarks
 * Used to back the chat-bundle WASM's persist + session-scoped storage
 * delegates so the WASM can save and load its own state across runs without
 * the SDK having to understand its serialization. Also backs the Web Storage
 * shims ({@link StorageShim} for `localStorage` / `sessionStorage`) and the
 * cookie jar ({@link CookieJarStore}) via stable key prefixes.
 *
 * Default impl is {@link FileDataStore}: a single JSON file with an
 * in-memory cache that flushes on every write. Consumers can plug in their
 * own (Redis, KMS, IndexedDB) by implementing the {@link DataStore}
 * interface — that's the public extension point.
 *
 * @see {@link DataStore}
 * @see {@link FileDataStore}
 * @see {@link MemoryDataStore}
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Persistent key-value storage interface — the SDK's pluggable persistence
 * backbone.
 *
 * @remarks
 * Implementations back the sandbox's `localStorage` / `sessionStorage` /
 * `indexedDB` / cookie jar. Bring your own (Redis, S3, KMS, …) by satisfying
 * this three-method async surface; pass an instance into
 * `new SnapcapClient({ dataStore })`.
 *
 * Values are arbitrary `Uint8Array` bytes — the SDK and bundle take care of
 * serialization on top.
 *
 * @example
 * Minimal in-memory implementation (essentially {@link MemoryDataStore}):
 *
 * ```ts
 * class MyStore implements DataStore {
 *   private map = new Map<string, Uint8Array>();
 *   async get(key: string)            { return this.map.get(key); }
 *   async set(key: string, v: Uint8Array) { this.map.set(key, v); }
 *   async delete(key: string)         { this.map.delete(key); }
 * }
 * ```
 *
 * @see {@link FileDataStore}
 * @see {@link MemoryDataStore}
 */
export interface DataStore {
  /**
   * Read the value at `key`.
   *
   * @param key - The storage key.
   * @returns The stored bytes, or `undefined` if the key is absent.
   */
  get(key: string): Promise<Uint8Array | undefined>;
  /**
   * Write `value` to `key`, overwriting any prior entry. Implementations
   * SHOULD make this durable before resolving.
   *
   * @param key - The storage key.
   * @param value - The bytes to store. Treat as immutable; the SDK never
   *   mutates the supplied buffer after passing it.
   */
  set(key: string, value: Uint8Array): Promise<void>;
  /**
   * Delete the entry at `key`. No-op if the key is absent.
   *
   * @param key - The storage key to remove.
   */
  delete(key: string): Promise<void>;
}

type OnDiskShape = Record<string, number[]>;

/**
 * File-backed {@link DataStore} implementation.
 *
 * @remarks
 * A single JSON file holds all entries; loaded into memory at construction;
 * eager flush on every `set` / `delete`.
 *
 * Also exposes synchronous {@link FileDataStore.getSync} /
 * {@link FileDataStore.setSync} / {@link FileDataStore.keys} for the Web
 * Storage shims, which implement the synchronous Web Storage API.
 *
 * @example
 * ```ts
 * import { SnapcapClient, FileDataStore } from "@snapcap/native";
 * const dataStore = new FileDataStore(".tmp/auth/auth.json");
 * const client = new SnapcapClient({ dataStore, username, password });
 * ```
 */
export class FileDataStore implements DataStore {
  private cache = new Map<string, Uint8Array>();

  /**
   * @param filePath - Absolute or working-directory-relative path to the
   *   JSON file backing this store. Parent directories are created on first
   *   flush; the file may be absent at construction time.
   */
  constructor(private filePath: string) {
    this.loadSync();
  }

  private loadSync(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const obj = JSON.parse(raw) as OnDiskShape;
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) this.cache.set(k, new Uint8Array(v));
      }
    } catch {
      // corrupt file → start fresh
    }
  }

  private async flush(): Promise<void> {
    const entries: string[] = [];
    for (const [k, v] of this.cache) {
      entries.push(`  ${JSON.stringify(k)}: ${JSON.stringify(Array.from(v))}`);
    }
    const out = entries.length === 0 ? "{}" : `{\n${entries.join(",\n")}\n}`;
    await mkdir(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, out);
  }

  /**
   * Synchronous read — for Web Storage shims that can't await.
   *
   * @param key - The storage key.
   * @returns The stored bytes, or `undefined` if absent.
   */
  getSync(key: string): Uint8Array | undefined {
    return this.cache.get(key);
  }

  /**
   * Synchronous variant of {@link FileDataStore.set} — fire-and-forget
   * flush. The in-memory cache update is immediate; the file write happens
   * asynchronously.
   *
   * @param key - The storage key.
   * @param value - The bytes to store.
   */
  setSync(key: string, value: Uint8Array): void {
    this.cache.set(key, new Uint8Array(value));
    void this.flush();
  }

  /** {@inheritDoc DataStore.get} */
  async get(key: string): Promise<Uint8Array | undefined> {
    return this.cache.get(key);
  }

  /** {@inheritDoc DataStore.set} */
  async set(key: string, value: Uint8Array): Promise<void> {
    this.cache.set(key, new Uint8Array(value));
    await this.flush();
  }

  /** {@inheritDoc DataStore.delete} */
  async delete(key: string): Promise<void> {
    if (this.cache.delete(key)) await this.flush();
  }

  /**
   * Iterate cached keys, optionally filtered by prefix.
   *
   * @param prefix - Optional prefix; only keys starting with this string
   *   are returned. When omitted, every key in the cache is returned.
   * @returns A snapshot array of matching keys.
   */
  keys(prefix?: string): string[] {
    const all = [...this.cache.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
}

/**
 * In-memory {@link DataStore} implementation — useful for tests and ephemeral
 * sandboxes.
 *
 * @remarks
 * Same surface as {@link FileDataStore} (including the synchronous helpers
 * the Web Storage shims need) but with no persistence. Contents are lost
 * when the process exits.
 *
 * @example
 * ```ts
 * import { SnapcapClient, MemoryDataStore } from "@snapcap/native";
 * const client = new SnapcapClient({
 *   dataStore: new MemoryDataStore(),
 *   username, password,
 * });
 * ```
 */
export class MemoryDataStore implements DataStore {
  private store = new Map<string, Uint8Array>();

  /** Synchronous read — for Web Storage shims that can't await. */
  getSync(key: string): Uint8Array | undefined {
    return this.store.get(key);
  }

  /** Synchronous variant of {@link MemoryDataStore.set}. */
  setSync(key: string, value: Uint8Array): void {
    this.store.set(key, new Uint8Array(value));
  }

  /** {@inheritDoc DataStore.get} */
  async get(key: string): Promise<Uint8Array | undefined> {
    return this.store.get(key);
  }

  /** {@inheritDoc DataStore.set} */
  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, new Uint8Array(value));
  }

  /** {@inheritDoc DataStore.delete} */
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Iterate stored keys, optionally filtered by prefix.
   *
   * @param prefix - Optional prefix filter. When omitted, every key is
   *   returned.
   * @returns A snapshot array of matching keys.
   */
  keys(prefix?: string): string[] {
    const all = [...this.store.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
}
