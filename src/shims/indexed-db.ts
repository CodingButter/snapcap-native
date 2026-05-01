/**
 * Minimal IndexedDB API shim, backed by a DataStore.
 *
 * Snap's bundle (and SDK code that wants persistence-friendly storage)
 * call `indexedDB.open(name, version)`, get a database, open a
 * transaction on a named object store, and put/get/delete/getAll/
 * getAllKeys/clear records. We don't implement indices, cursors, or
 * IDBKeyRange — the bundle and SDK don't reach for them.
 *
 * Storage layout in the underlying DataStore:
 *
 *   indexdb_<dbName>__<storeName>__<key>
 *
 * Two-underscore separators keep `_` inside any user-supplied key from
 * colliding with our delimiter. Values are JSON-encoded UTF-8 bytes so
 * the DataStore stores them alongside other prefixed entries (cookies,
 * `local_*`, `session_*`).
 *
 * Requests follow the standard IDB shape: callback-based, with
 * `onsuccess` / `onerror` fired on the next microtask. We wire
 * `target.result` and `target.error` to match what real IDB code expects.
 */
import type { DataStore } from "../storage/data-store.ts";
import { Shim, type ShimContext } from "./types.ts";
import type { Sandbox } from "./sandbox.ts";

type Listable = DataStore & {
  keys?: (prefix?: string) => string[];
};

const PREFIX = "indexdb_";
const SEP = "__";

function makeFullKey(dbName: string, storeName: string, key: IDBValidKey): string {
  return `${PREFIX}${dbName}${SEP}${storeName}${SEP}${String(key)}`;
}

function makeStorePrefix(dbName: string, storeName: string): string {
  return `${PREFIX}${dbName}${SEP}${storeName}${SEP}`;
}

type IDBValidKey = string | number;

interface ShimRequestEvent {
  target: IDBRequestShim;
  type: string;
}

/**
 * IDBRequest-like object. Real IDB requests fire onsuccess / onerror
 * once asynchronously after the operation completes. We schedule those
 * via queueMicrotask so user code that attaches listeners synchronously
 * after the call still sees them invoked.
 */
class IDBRequestShim {
  result: unknown = undefined;
  error: Error | null = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: ((ev: ShimRequestEvent) => void) | null = null;
  onerror: ((ev: ShimRequestEvent) => void) | null = null;
  /** transaction ref so user code can read req.transaction.objectStore(...) etc. */
  transaction: IDBTransactionShim | null = null;

  /** Resolve immediately as success and fire onsuccess on a microtask. */
  succeed(result: unknown): void {
    this.result = result;
    this.readyState = "done";
    queueMicrotask(() => {
      this.onsuccess?.({ target: this, type: "success" });
    });
  }

  fail(err: Error): void {
    this.error = err;
    this.readyState = "done";
    queueMicrotask(() => {
      this.onerror?.({ target: this, type: "error" });
    });
  }
}

/** Open-request variant has the extra onupgradeneeded callback. */
class IDBOpenDBRequestShim extends IDBRequestShim {
  onupgradeneeded: ((ev: ShimRequestEvent) => void) | null = null;
  onblocked: ((ev: ShimRequestEvent) => void) | null = null;
}

class IDBObjectStoreShim {
  constructor(
    private store: DataStore,
    private dbName: string,
    public name: string,
    public transaction: IDBTransactionShim,
  ) {}

  get(key: IDBValidKey): IDBRequestShim {
    const req = new IDBRequestShim();
    req.transaction = this.transaction;
    void this.store.get(makeFullKey(this.dbName, this.name, key)).then(
      (bytes) => {
        if (!bytes || bytes.byteLength === 0) {
          req.succeed(undefined);
        } else {
          try {
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            req.succeed(parsed);
          } catch (e) {
            req.fail(e as Error);
          }
        }
      },
      (e) => req.fail(e as Error),
    );
    return req;
  }

  /** put(value, key?) — second arg required for stores without keyPath. */
  put(value: unknown, key?: IDBValidKey): IDBRequestShim {
    const req = new IDBRequestShim();
    req.transaction = this.transaction;
    if (key === undefined) {
      // We don't model keyPath/inline keys; require an explicit key.
      req.fail(new Error("IDBObjectStore.put requires explicit key (shim does not model keyPath)"));
      return req;
    }
    let bytes: Uint8Array;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(value));
    } catch (e) {
      req.fail(e as Error);
      return req;
    }
    void this.store.set(makeFullKey(this.dbName, this.name, key), bytes).then(
      () => {
        this.transaction._noteOp();
        req.succeed(key);
      },
      (e) => req.fail(e as Error),
    );
    return req;
  }

  /** add() behaves like put() in our shim — no key-uniqueness enforcement. */
  add(value: unknown, key?: IDBValidKey): IDBRequestShim {
    return this.put(value, key);
  }

  delete(key: IDBValidKey): IDBRequestShim {
    const req = new IDBRequestShim();
    req.transaction = this.transaction;
    void this.store.delete(makeFullKey(this.dbName, this.name, key)).then(
      () => {
        this.transaction._noteOp();
        req.succeed(undefined);
      },
      (e) => req.fail(e as Error),
    );
    return req;
  }

  clear(): IDBRequestShim {
    const req = new IDBRequestShim();
    req.transaction = this.transaction;
    const listable = this.store as Listable;
    if (typeof listable.keys !== "function") {
      // Without listing we can't enumerate — best-effort no-op success.
      this.transaction._noteOp();
      req.succeed(undefined);
      return req;
    }
    const prefix = makeStorePrefix(this.dbName, this.name);
    const allKeys = listable.keys(prefix);
    void Promise.all(allKeys.map((k) => this.store.delete(k))).then(
      () => {
        this.transaction._noteOp();
        req.succeed(undefined);
      },
      (e) => req.fail(e as Error),
    );
    return req;
  }

  getAll(): IDBRequestShim {
    const req = new IDBRequestShim();
    req.transaction = this.transaction;
    const listable = this.store as Listable;
    if (typeof listable.keys !== "function") {
      req.succeed([]);
      return req;
    }
    const prefix = makeStorePrefix(this.dbName, this.name);
    const allKeys = listable.keys(prefix);
    void Promise.all(allKeys.map((k) => this.store.get(k))).then(
      (allBytes) => {
        const out: unknown[] = [];
        for (const bytes of allBytes) {
          if (!bytes || bytes.byteLength === 0) continue;
          try {
            out.push(JSON.parse(new TextDecoder().decode(bytes)));
          } catch {
            // skip corrupt entry
          }
        }
        req.succeed(out);
      },
      (e) => req.fail(e as Error),
    );
    return req;
  }

  getAllKeys(): IDBRequestShim {
    const req = new IDBRequestShim();
    req.transaction = this.transaction;
    const listable = this.store as Listable;
    if (typeof listable.keys !== "function") {
      req.succeed([]);
      return req;
    }
    const prefix = makeStorePrefix(this.dbName, this.name);
    const stripped = listable.keys(prefix).map((k) => k.slice(prefix.length));
    req.succeed(stripped);
    return req;
  }
}

class IDBTransactionShim {
  /** Real IDB fires oncomplete after all queued ops settle; we approximate. */
  oncomplete: ((ev: ShimRequestEvent) => void) | null = null;
  onerror: ((ev: ShimRequestEvent) => void) | null = null;
  onabort: ((ev: ShimRequestEvent) => void) | null = null;
  /** Pending op count; when it returns to zero after at least one op we fire complete. */
  private pending = 0;
  private hadOp = false;
  private completed = false;

  constructor(
    private store: DataStore,
    private dbName: string,
    public storeNames: string[],
    public mode: IDBTransactionMode,
  ) {
    // Schedule a tick: if no ops were enqueued synchronously, complete
    // anyway on the next microtask so consumers waiting on oncomplete
    // for a no-op tx (rare) don't hang.
    queueMicrotask(() => {
      if (!this.hadOp) this._tryComplete();
    });
  }

  objectStore(name: string): IDBObjectStoreShim {
    return new IDBObjectStoreShim(this.store, this.dbName, name, this);
  }

  /** Internal: object-store op records that an async op happened. */
  _noteOp(): void {
    this.hadOp = true;
    this.pending++;
    queueMicrotask(() => {
      this.pending--;
      this._tryComplete();
    });
  }

  private _tryComplete(): void {
    if (this.completed) return;
    if (this.pending > 0) return;
    this.completed = true;
    queueMicrotask(() => {
      this.oncomplete?.({ target: this as unknown as IDBRequestShim, type: "complete" });
    });
  }
}

type IDBTransactionMode = "readonly" | "readwrite" | "versionchange";

class IDBDatabaseShim {
  /** Object store names known to this database. We just track which ones
   *  the upgrade callback created — we don't actually segment storage by it. */
  objectStoreNames: { contains: (n: string) => boolean; length: number; [i: number]: string };
  private knownStores = new Set<string>();
  onversionchange: ((ev: ShimRequestEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    private store: DataStore,
    public name: string,
    public version: number,
  ) {
    this.objectStoreNames = this._buildStoreNames();
  }

  private _buildStoreNames(): { contains: (n: string) => boolean; length: number; [i: number]: string } {
    const arr = [...this.knownStores];
    const obj: { contains: (n: string) => boolean; length: number; [i: number]: string } = {
      contains: (n: string) => this.knownStores.has(n),
      length: arr.length,
    };
    for (let i = 0; i < arr.length; i++) obj[i] = arr[i]!;
    return obj;
  }

  createObjectStore(name: string): IDBObjectStoreShim {
    this.knownStores.add(name);
    this.objectStoreNames = this._buildStoreNames();
    // Return an objectStore bound to a synthetic versionchange tx so
    // upgrade-time put()s (rare in our code, but allowed) work.
    const tx = new IDBTransactionShim(this.store, this.name, [name], "versionchange");
    return new IDBObjectStoreShim(this.store, this.name, name, tx);
  }

  deleteObjectStore(name: string): void {
    this.knownStores.delete(name);
    this.objectStoreNames = this._buildStoreNames();
  }

  transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly"): IDBTransactionShim {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new IDBTransactionShim(this.store, this.name, names, mode);
  }

  close(): void {
    this.onclose?.();
  }
}

/**
 * IDBFactory shim — entry point for `indexedDB.open(name, version)`.
 * Tracks per-database versions in memory for the duration of the
 * sandbox's life so upgradeneeded fires once per name.
 */
export class IDBFactoryShim {
  private versions = new Map<string, number>();

  constructor(private store: DataStore) {}

  open(name: string, version: number = 1): IDBOpenDBRequestShim {
    const req = new IDBOpenDBRequestShim();
    const prevVersion = this.versions.get(name) ?? 0;
    const db = new IDBDatabaseShim(this.store, name, version);
    req.result = db;

    // Fire upgradeneeded synchronously on a microtask if version bumped,
    // then success after the upgrade callback returns (so createObjectStore
    // calls inside it land before consumers hit success).
    queueMicrotask(() => {
      if (version > prevVersion) {
        this.versions.set(name, version);
        try {
          req.onupgradeneeded?.({ target: req, type: "upgradeneeded" });
        } catch (e) {
          req.fail(e as Error);
          return;
        }
      }
      // success uses the same target.result we already pre-set.
      req.readyState = "done";
      req.onsuccess?.({ target: req, type: "success" });
    });

    return req;
  }

  deleteDatabase(name: string): IDBOpenDBRequestShim {
    const req = new IDBOpenDBRequestShim();
    const listable = this.store as Listable;
    if (typeof listable.keys !== "function") {
      req.succeed(undefined);
      return req;
    }
    const prefix = `${PREFIX}${name}${SEP}`;
    const allKeys = listable.keys(prefix);
    void Promise.all(allKeys.map((k) => this.store.delete(k))).then(
      () => {
        this.versions.delete(name);
        req.succeed(undefined);
      },
      (e) => req.fail(e as Error),
    );
    return req;
  }

  /** Spec method we don't need; return [] so feature-detection paths work. */
  databases(): Promise<{ name: string; version: number }[]> {
    return Promise.resolve(
      [...this.versions.entries()].map(([name, version]) => ({ name, version })),
    );
  }

  cmp(a: IDBValidKey, b: IDBValidKey): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
}

/**
 * `Shim`-shaped wrapper that installs `IDBFactoryShim` as the sandbox's
 * `indexedDB` global. Independent of the cookie pipeline — order against
 * cookie shims is irrelevant.
 */
export class IndexedDbShim extends Shim {
  readonly name = "indexed-db";
  install(sandbox: Sandbox, ctx: ShimContext): void {
    sandbox.window.indexedDB = new IDBFactoryShim(ctx.dataStore);
  }
}
