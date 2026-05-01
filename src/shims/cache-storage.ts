/**
 * Sandbox `Cache Storage API` shim — installs DataStore-backed `caches`
 * onto the sandbox global so `caches.open(name).then(c => c.put(req, res))`
 * actually persists, surviving SDK process restarts.
 *
 * Why this exists:
 *   The bundle has been observed to feature-detect `caches` and silently
 *   skip persistence when it's a no-op stub (the previous behaviour in
 *   `sandbox.ts:177-186`). If the bundle ever uses `caches` for any
 *   real persistence — partial responses, attestation tokens, anything
 *   request-keyed — those writes vanished. This shim turns it into real
 *   storage so cross-session state isn't silently dropped.
 *
 * Storage layout in the underlying DataStore:
 *
 *   cache:_index                              JSON: string[]   (cache names)
 *   cache:<cacheName>:_index                  JSON: Entry[]    ({method,url}[])
 *   cache:<cacheName>:<method>:<url>:meta     JSON metadata    ({status,statusText,headers})
 *   cache:<cacheName>:<method>:<url>:body     raw bytes        (Uint8Array)
 *
 * We deliberately maintain two indices (cache names + per-cache entry list)
 * INSTEAD of relying on `DataStore.keys(prefix)`. The `DataStore` interface
 * (`storage/data-store.ts:18-22`) does not expose `keys` — it's a
 * `FileDataStore`/`MemoryDataStore`-only convenience. Consumers may plug in
 * a Redis or KMS-backed DataStore that has neither prefix-scan nor a
 * meaningful `keys()`; the index approach works for any conforming impl.
 *
 * Body bytes are stored RAW (not JSON-wrapped) at the `:body` key so we
 * don't pay base64/hex overhead for every cached response — the metadata
 * keeps the JSON easy to read for debugging, and binary payloads stay
 * binary on disk.
 *
 * Cross-realm: outgoing `Response` and `Request` instances must be
 * constructed with sandbox-realm constructors so `instanceof` checks
 * inside bundle code pass. We resolve those once via `sandbox.runInContext`
 * (mirrors the XHR shim's `VmArrayBuffer` pattern). Body bytes go through
 * `sandbox.toVmU8` so the Response's body is a sandbox-realm `Uint8Array`.
 */
import type { DataStore } from "../storage/data-store.ts";
import { nativeFetch } from "../transport/native-fetch.ts";
import type { Sandbox } from "./sandbox.ts";
import { Shim, type ShimContext } from "./types.ts";

const CACHE_NAMES_INDEX_KEY = "cache:_index";

/** Per-entry pointer kept in `cache:<name>:_index`. */
interface EntryRef {
  method: string;
  url: string;
}

/** Persisted JSON for a single response (body stored separately). */
interface EntryMeta {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Anything Cache.put / Cache.match accepts as the request arg. */
type RequestLike = string | { url: string; method?: string };

/** A sandbox-realm Response (so `instanceof Response` passes inside bundle). */
type VmResponse = Response;

function jsonBytes(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

function parseJson<T>(bytes: Uint8Array | undefined, fallback: T): T {
  if (!bytes || bytes.byteLength === 0) return fallback;
  try {
    return JSON.parse(dec.decode(bytes)) as T;
  } catch {
    return fallback;
  }
}

/** Normalise the various shapes Cache methods accept into `{method, url}`. */
function normalizeRequest(req: RequestLike): EntryRef {
  if (typeof req === "string") {
    return { method: "GET", url: req };
  }
  // Request-shaped (sandbox or host realm). Method may be missing on plain
  // URL strings projected as objects.
  const method = (req.method ?? "GET").toUpperCase();
  return { method, url: req.url };
}

function metaKey(cacheName: string, ref: EntryRef): string {
  return `cache:${cacheName}:${ref.method}:${ref.url}:meta`;
}
function bodyKey(cacheName: string, ref: EntryRef): string {
  return `cache:${cacheName}:${ref.method}:${ref.url}:body`;
}
function entryIndexKey(cacheName: string): string {
  return `cache:${cacheName}:_index`;
}

/** Compare two `EntryRef`s by url+method. */
function refEq(a: EntryRef, b: EntryRef): boolean {
  return a.method === b.method && a.url === b.url;
}

/**
 * Per-`Cache` instance. Each `caches.open(name)` returns one of these,
 * sharing the underlying DataStore + the same per-cache index key.
 */
class CacheImpl {
  constructor(
    private store: DataStore,
    private name: string,
    private sandbox: Sandbox,
    private VmResponseCtor: typeof Response,
    private VmRequestCtor: typeof Request,
  ) {}

  // ── index helpers ──────────────────────────────────────────────────────

  private async readIndex(): Promise<EntryRef[]> {
    return parseJson<EntryRef[]>(await this.store.get(entryIndexKey(this.name)), []);
  }

  private async writeIndex(entries: EntryRef[]): Promise<void> {
    await this.store.set(entryIndexKey(this.name), jsonBytes(entries));
  }

  private async addToIndex(ref: EntryRef): Promise<void> {
    const idx = await this.readIndex();
    if (!idx.some((e) => refEq(e, ref))) {
      idx.push(ref);
      await this.writeIndex(idx);
    }
  }

  private async removeFromIndex(ref: EntryRef): Promise<boolean> {
    const idx = await this.readIndex();
    const next = idx.filter((e) => !refEq(e, ref));
    if (next.length === idx.length) return false;
    await this.writeIndex(next);
    return true;
  }

  // ── Cache API surface ──────────────────────────────────────────────────

  async put(request: RequestLike, response: VmResponse): Promise<void> {
    const ref = normalizeRequest(request);
    if (!response) {
      throw new Error("Cache.put: response is required");
    }
    // Drain body once — Response bodies are single-use streams. Buffer it
    // so we can both persist AND hand back a re-readable Response from
    // subsequent match() calls.
    let bodyBytes: Uint8Array;
    try {
      const ab = await response.arrayBuffer();
      bodyBytes = new Uint8Array(ab);
    } catch (e) {
      throw new Error(`Cache.put: failed to read response body: ${(e as Error).message}`);
    }

    const headers: Record<string, string> = {};
    try {
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } catch {
      /* malformed/empty headers — proceed without them */
    }
    const meta: EntryMeta = {
      status: response.status ?? 200,
      // Browsers reject statusText:"" in the Response ctor for some statuses
      // — keep it but normalise to a non-empty default.
      statusText: response.statusText || "",
      headers,
    };

    await this.store.set(metaKey(this.name, ref), jsonBytes(meta));
    await this.store.set(bodyKey(this.name, ref), bodyBytes);
    await this.addToIndex(ref);
  }

  async match(request: RequestLike, _options?: unknown): Promise<VmResponse | undefined> {
    const ref = normalizeRequest(request);
    const metaBytes = await this.store.get(metaKey(this.name, ref));
    if (!metaBytes || metaBytes.byteLength === 0) return undefined;
    const meta = parseJson<EntryMeta | null>(metaBytes, null);
    if (!meta) return undefined;
    const bodyBytes = (await this.store.get(bodyKey(this.name, ref))) ?? new Uint8Array(0);
    return this.buildResponse(bodyBytes, meta);
  }

  async matchAll(request?: RequestLike, _options?: unknown): Promise<VmResponse[]> {
    const idx = await this.readIndex();
    const targets = request === undefined
      ? idx
      : idx.filter((e) => refEq(e, normalizeRequest(request)));
    const out: VmResponse[] = [];
    for (const ref of targets) {
      const r = await this.match(ref);
      if (r) out.push(r);
    }
    return out;
  }

  async add(request: RequestLike): Promise<void> {
    const ref = normalizeRequest(request);
    if (ref.method !== "GET") {
      throw new Error("Cache.add: only GET requests are supported");
    }
    const res = await nativeFetch(ref.url);
    if (!res.ok) {
      throw new Error(`Cache.add: fetch failed for ${ref.url} (status ${res.status})`);
    }
    // `nativeFetch`'s Response is host-realm; that's fine — `put` reads
    // arrayBuffer() and rebuilds a sandbox-realm Response on match().
    await this.put(ref, res as unknown as VmResponse);
  }

  async addAll(requests: RequestLike[]): Promise<void> {
    await Promise.all(requests.map((r) => this.add(r)));
  }

  async delete(request: RequestLike, _options?: unknown): Promise<boolean> {
    const ref = normalizeRequest(request);
    const removed = await this.removeFromIndex(ref);
    if (!removed) return false;
    await this.store.delete(metaKey(this.name, ref));
    await this.store.delete(bodyKey(this.name, ref));
    return true;
  }

  async keys(request?: RequestLike, _options?: unknown): Promise<Request[]> {
    const idx = await this.readIndex();
    const targets = request === undefined
      ? idx
      : idx.filter((e) => refEq(e, normalizeRequest(request)));
    return targets.map((ref) => new this.VmRequestCtor(ref.url, { method: ref.method }));
  }

  /** Internal: drop everything for this cache. Called by CacheStorage.delete. */
  async _deleteAll(): Promise<void> {
    const idx = await this.readIndex();
    for (const ref of idx) {
      await this.store.delete(metaKey(this.name, ref));
      await this.store.delete(bodyKey(this.name, ref));
    }
    await this.store.delete(entryIndexKey(this.name));
  }

  /** Build a sandbox-realm Response from on-disk bytes + meta. */
  private buildResponse(bodyBytes: Uint8Array, meta: EntryMeta): VmResponse {
    // Sandbox-realm Uint8Array — required so the Response body is in the
    // bundle's realm (cross-realm typed-array views break `instanceof`
    // inside bundle code; same reason `toVmU8` exists for protobuf decode).
    // Cast via BodyInit because TS's Response init type is narrower than
    // the runtime, which accepts any TypedArray.
    const vmBytes = this.sandbox.toVmU8(bodyBytes) as unknown as BodyInit;
    // statusText cannot be set via `init` for status 200 in some Response
    // impls — pass it but tolerate ctor rejecting it.
    try {
      return new this.VmResponseCtor(vmBytes, {
        status: meta.status,
        statusText: meta.statusText,
        headers: meta.headers,
      });
    } catch {
      return new this.VmResponseCtor(vmBytes, {
        status: meta.status,
        headers: meta.headers,
      });
    }
  }
}

/**
 * `caches` global — entry point for `caches.open(name)`. Holds the cross-
 * cache name registry at `cache:_index`.
 */
class CacheStorageImpl {
  private opened = new Map<string, CacheImpl>();

  constructor(
    private store: DataStore,
    private sandbox: Sandbox,
    private VmResponseCtor: typeof Response,
    private VmRequestCtor: typeof Request,
  ) {}

  private async readNames(): Promise<string[]> {
    return parseJson<string[]>(await this.store.get(CACHE_NAMES_INDEX_KEY), []);
  }

  private async writeNames(names: string[]): Promise<void> {
    await this.store.set(CACHE_NAMES_INDEX_KEY, jsonBytes(names));
  }

  async open(name: string): Promise<CacheImpl> {
    const cached = this.opened.get(name);
    if (cached) return cached;
    const names = await this.readNames();
    if (!names.includes(name)) {
      names.push(name);
      await this.writeNames(names);
    }
    const cache = new CacheImpl(
      this.store,
      name,
      this.sandbox,
      this.VmResponseCtor,
      this.VmRequestCtor,
    );
    this.opened.set(name, cache);
    return cache;
  }

  async has(name: string): Promise<boolean> {
    const names = await this.readNames();
    return names.includes(name);
  }

  async delete(name: string): Promise<boolean> {
    const names = await this.readNames();
    const next = names.filter((n) => n !== name);
    if (next.length === names.length) return false;
    // Wipe entries first so a concurrent open() can't see stale rows.
    const cache = this.opened.get(name) ?? new CacheImpl(
      this.store,
      name,
      this.sandbox,
      this.VmResponseCtor,
      this.VmRequestCtor,
    );
    await cache._deleteAll();
    this.opened.delete(name);
    await this.writeNames(next);
    return true;
  }

  async keys(): Promise<string[]> {
    return this.readNames();
  }

  async match(request: RequestLike, options?: unknown): Promise<VmResponse | undefined> {
    const names = await this.readNames();
    for (const name of names) {
      const cache = await this.open(name);
      const hit = await cache.match(request, options);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * `Shim`-shaped wrapper. Overwrites whatever `caches` is on the sandbox
 * global (the empty stub installed by `sandbox.ts` — kept as a fallback
 * for the no-DataStore configuration where {@link SDK_SHIMS} doesn't run)
 * with a real DataStore-backed `CacheStorage`.
 *
 * @internal
 */
export class CacheStorageShim extends Shim {
  /** @internal */
  readonly name = "cache-storage";

  /** @internal */
  install(sandbox: Sandbox, ctx: ShimContext): void {
    const VmResponseCtor = sandbox.runInContext("Response") as typeof Response;
    const VmRequestCtor = sandbox.runInContext("Request") as typeof Request;
    sandbox.window.caches = new CacheStorageImpl(
      ctx.dataStore,
      sandbox,
      VmResponseCtor,
      VmRequestCtor,
    );
  }
}
