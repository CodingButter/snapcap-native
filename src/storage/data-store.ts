/**
 * Persistent key-value storage abstraction for the SDK.
 *
 * Used to back the chat-bundle WASM's persist and session-scoped storage
 * delegates so the WASM can save and load its own state (wrapped identity
 * keys, root wrapping key, temp identity key) across runs without our SDK
 * having to understand the wire shape.
 *
 * Default impl writes each key as a separate file under a directory.
 * Consumers can plug in their own (Redis, KMS, in-memory, etc.) by
 * implementing the `DataStore` interface.
 */
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DataStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Filesystem-backed DataStore. Each key becomes a file under `dir`. */
export class FileDataStore implements DataStore {
  constructor(private dir: string) {}

  private path(key: string): string {
    // Replace path separators in keys so nested keys are safe.
    return join(this.dir, key.replace(/\//g, "__"));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    if (existsSync(path)) await unlink(path);
  }
}

/** In-memory DataStore — useful for tests. */
export class MemoryDataStore implements DataStore {
  private store = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    // Copy to avoid aliasing on mutating callers.
    this.store.set(key, new Uint8Array(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
