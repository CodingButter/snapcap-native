/**
 * Promise-friendly IndexedDB helpers.
 *
 * @remarks
 * The SDK persists Fidelius identity (and any future stateful blobs we want
 * sandbox-visible) by going through the IDB shim rather than touching the
 * {@link DataStore} directly. That way:
 *
 * - keys land under the same `indexdb_<db>__<store>__<key>` namespace the
 *   bundle uses, so consumers see one coherent persistence layout;
 * - if a {@link DataStore} was passed to the sandbox, our IDB shim takes the
 *   write; otherwise we fall through to happy-dom's in-memory IDB and things
 *   still work in tests.
 *
 * Each call opens the database with the named object store, runs one op,
 * and waits for the transaction to settle. The shim is cheap so we don't
 * bother caching the `IDBDatabase` across calls.
 *
 * Each helper takes the target {@link Sandbox} as its first argument —
 * multi-tenant runners pass their per-client Sandbox so reads/writes
 * land in the right realm's IDB shim instead of a process-singleton.
 *
 * @example
 * ```ts
 * import { idbGet, idbPut, idbDelete, Sandbox } from "@snapcap/native";
 *
 * const sandbox = new Sandbox({ dataStore });
 * await idbPut(sandbox, "snapcap", "fidelius", "identity", blob);
 * const blob = await idbGet<MyBlob>(sandbox, "snapcap", "fidelius", "identity");
 * await idbDelete(sandbox, "snapcap", "fidelius", "identity");
 * ```
 *
 * @see {@link idbGet}
 * @see {@link idbPut}
 * @see {@link idbDelete}
 */
import type { Sandbox } from "../shims/sandbox.ts";

/** Minimum IDB surface we consume here — matches our shim and real IDB. */
type MiniRequest = {
  onsuccess: ((ev: { target: { result: unknown } }) => void) | null;
  onerror: ((ev: { target: { error?: Error | null } }) => void) | null;
  result?: unknown;
  error?: Error | null;
};
type MiniOpenRequest = MiniRequest & {
  onupgradeneeded: ((ev: { target: { result: MiniDatabase } }) => void) | null;
};
type MiniObjectStore = {
  get: (key: string) => MiniRequest;
  put: (value: unknown, key?: string) => MiniRequest;
  delete: (key: string) => MiniRequest;
};
type MiniTransaction = {
  objectStore: (name: string) => MiniObjectStore;
  oncomplete: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onabort: ((ev: unknown) => void) | null;
};
type MiniDatabase = {
  transaction: (storeNames: string[], mode: "readonly" | "readwrite") => MiniTransaction;
  createObjectStore: (name: string) => MiniObjectStore;
  objectStoreNames: { contains: (n: string) => boolean };
  close?: () => void;
};
type MiniFactory = {
  open: (name: string, version?: number) => MiniOpenRequest;
};

/**
 * Resolve the sandbox's `indexedDB` global. With a {@link DataStore}
 * configured this is our shim; without one it's happy-dom's default. We
 * tolerate either shape — the property surface we use is identical.
 *
 * @internal
 */
function getIDB(sandbox: Sandbox): MiniFactory {
  const idb = sandbox.getGlobal<MiniFactory>("indexedDB");
  if (!idb) throw new Error("indexedDB is not available on the sandbox");
  return idb;
}

/**
 * Open `dbName`, ensure `storeName` exists (creates it via the upgrade
 * callback on first use), and resolve the database handle. Each call uses a
 * fresh `version=1` open — for an existing store the upgrade branch never
 * fires.
 *
 * @internal
 */
function openDb(sandbox: Sandbox, dbName: string, storeName: string): Promise<MiniDatabase> {
  const idb = getIDB(sandbox);
  return new Promise<MiniDatabase>((resolve, reject) => {
    const req = idb.open(dbName, 1);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    req.onsuccess = (ev) => {
      resolve((ev.target as { result: MiniDatabase }).result);
    };
    req.onerror = (ev) => {
      reject((ev.target as { error?: Error | null }).error ?? new Error(`indexedDB.open(${dbName}) failed`));
    };
  });
}

/**
 * Run a single object-store op inside a transaction and wait for completion.
 *
 * @internal
 */
function runOp<T>(
  db: MiniDatabase,
  storeName: string,
  mode: "readonly" | "readwrite",
  body: (store: MiniObjectStore) => MiniRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([storeName], mode);
    const store = tx.objectStore(storeName);
    const req = body(store);
    let opResult: unknown;
    let opErr: Error | null = null;
    req.onsuccess = (ev) => {
      opResult = (ev.target as { result: unknown }).result;
    };
    req.onerror = (ev) => {
      opErr = (ev.target as { error?: Error | null }).error ?? new Error("idb op failed");
    };
    tx.oncomplete = () => {
      if (opErr) reject(opErr);
      else resolve(opResult as T);
      db.close?.();
    };
    tx.onerror = () => {
      reject(opErr ?? new Error("idb tx error"));
      db.close?.();
    };
    tx.onabort = () => {
      reject(opErr ?? new Error("idb tx aborted"));
      db.close?.();
    };
  });
}

/**
 * Read a value from the given Sandbox's IndexedDB at `(dbName, storeName, key)`.
 *
 * @typeParam T - The value type stored at this key.
 * @param sandbox - The {@link Sandbox} whose IDB shim handles the read.
 * @param dbName - IndexedDB database name.
 * @param storeName - Object store name within the database. Created on
 *   first use if absent.
 * @param key - Record key within the object store.
 * @returns The stored value, or `undefined` if absent.
 *
 * @example
 * ```ts
 * const identity = await idbGet<{ pub: Uint8Array }>(sandbox, "snapcap", "fidelius", "identity");
 * ```
 *
 * @see {@link idbPut}
 * @see {@link idbDelete}
 */
export async function idbGet<T = unknown>(
  sandbox: Sandbox,
  dbName: string,
  storeName: string,
  key: string,
): Promise<T | undefined> {
  const db = await openDb(sandbox, dbName, storeName);
  return runOp<T | undefined>(db, storeName, "readonly", (s) => s.get(key));
}

/**
 * Write `value` into the given Sandbox's IndexedDB at `(dbName, storeName, key)`.
 *
 * @param sandbox - The {@link Sandbox} whose IDB shim handles the write.
 * @param dbName - IndexedDB database name.
 * @param storeName - Object store name within the database. Created on
 *   first use if absent.
 * @param key - Record key within the object store.
 * @param value - Any structured-cloneable value.
 *
 * @example
 * ```ts
 * await idbPut(sandbox, "snapcap", "fidelius", "identity", { pub, priv });
 * ```
 *
 * @see {@link idbGet}
 * @see {@link idbDelete}
 */
export async function idbPut(
  sandbox: Sandbox,
  dbName: string,
  storeName: string,
  key: string,
  value: unknown,
): Promise<void> {
  const db = await openDb(sandbox, dbName, storeName);
  await runOp<unknown>(db, storeName, "readwrite", (s) => s.put(value, key));
}

/**
 * Delete the entry at `(dbName, storeName, key)` in the given Sandbox's
 * IndexedDB. No-op if absent.
 *
 * @param sandbox - The {@link Sandbox} whose IDB shim handles the delete.
 * @param dbName - IndexedDB database name.
 * @param storeName - Object store name within the database.
 * @param key - Record key within the object store.
 *
 * @see {@link idbGet}
 * @see {@link idbPut}
 */
export async function idbDelete(
  sandbox: Sandbox,
  dbName: string,
  storeName: string,
  key: string,
): Promise<void> {
  const db = await openDb(sandbox, dbName, storeName);
  await runOp<unknown>(db, storeName, "readwrite", (s) => s.delete(key));
}
