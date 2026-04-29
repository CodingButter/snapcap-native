/**
 * Single-file JSON-backed DataStore.
 *
 * Loads the entire store into an in-memory map at construction; reads and
 * writes are O(1) against the map. Writes flush to disk eagerly (after each
 * `set` / `delete`) but the API is async, so callers should `await` to
 * confirm persistence. A `getSync` is exposed so synchronous APIs (Web
 * Storage's `getItem`) can read against the cache.
 *
 * The on-disk layout is one JSON object whose keys are storage keys and
 * whose values are arrays of byte ints (so JSON survives without base64
 * but stays human-inspectable). Used together with the Storage shims,
 * this lets one file hold cookies, bearer, WASM-persisted state, and
 * any localStorage/sessionStorage entries — namespaced by prefix.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DataStore } from "./data-store.ts";

type OnDiskShape = Record<string, number[]>;

export class JsonFileDataStore implements DataStore {
  private cache = new Map<string, Uint8Array>();
  private loaded = false;

  constructor(private filePath: string) {
    this.loadSync();
  }

  private loadSync(): void {
    if (!existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const obj = JSON.parse(raw) as OnDiskShape;
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) this.cache.set(k, new Uint8Array(v));
      }
    } catch {
      // corrupt file → start fresh
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    const obj: OnDiskShape = {};
    for (const [k, v] of this.cache) obj[k] = Array.from(v);
    await mkdir(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(obj));
  }

  /** Synchronous read — for Web Storage shims that can't await. */
  getSync(key: string): Uint8Array | undefined {
    return this.cache.get(key);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.cache.set(key, new Uint8Array(value));
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    if (this.cache.delete(key)) {
      await this.flush();
    }
  }

  /** Synchronous variant of set — fire-and-forget flush. Use sparingly. */
  setSync(key: string, value: Uint8Array): void {
    this.cache.set(key, new Uint8Array(value));
    void this.flush();
  }

  /** Iterate keys, optionally filtered by prefix. */
  keys(prefix?: string): string[] {
    const all = [...this.cache.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }
}
