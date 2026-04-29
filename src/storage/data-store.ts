/**
 * Persistent key-value storage abstraction for the SDK.
 *
 * Used to back the chat-bundle WASM's persist + session-scoped storage
 * delegates so the WASM can save and load its own state across runs
 * without our SDK having to understand its serialization. Also backs the
 * Web Storage shims (localStorage, sessionStorage) and the cookie jar
 * via stable key prefixes.
 *
 * Default impl is `FileDataStore`: a single JSON file with an in-memory
 * cache that flushes on every write. Consumers can plug in their own
 * (Redis, KMS, IndexedDB) by implementing the `DataStore` interface.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface DataStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

type OnDiskShape = Record<string, number[]>;

/**
 * File-backed DataStore. Single JSON file holds all entries; loaded into
 * memory at construction; eager flush on every set/delete.
 *
 * Exposes synchronous getSync/setSync/keys for the Storage shims, which
 * implement the synchronous Web Storage API.
 */
export class FileDataStore implements DataStore {
  private cache = new Map<string, Uint8Array>();

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

  /** Synchronous read — for Web Storage shims that can't await. */
  getSync(key: string): Uint8Array | undefined {
    return this.cache.get(key);
  }

  /** Synchronous variant of set — fire-and-forget flush. */
  setSync(key: string, value: Uint8Array): void {
    this.cache.set(key, new Uint8Array(value));
    void this.flush();
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.cache.set(key, new Uint8Array(value));
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    if (this.cache.delete(key)) await this.flush();
  }

  /** Iterate keys, optionally filtered by prefix. */
  keys(prefix?: string): string[] {
    const all = [...this.cache.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
}

/** In-memory DataStore — useful for tests. */
export class MemoryDataStore implements DataStore {
  private store = new Map<string, Uint8Array>();

  getSync(key: string): Uint8Array | undefined {
    return this.store.get(key);
  }

  setSync(key: string, value: Uint8Array): void {
    this.store.set(key, new Uint8Array(value));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, new Uint8Array(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  keys(prefix?: string): string[] {
    const all = [...this.store.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
}
