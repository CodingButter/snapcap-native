/**
 * Promise-friendly IndexedDB helpers.
 *
 * The SDK persists Fidelius identity (and any future stateful blobs we
 * want sandbox-visible) by going through the IDB shim rather than
 * touching the DataStore directly. That way:
 *
 *   - keys land under the same `indexdb_<db>__<store>__<key>` namespace
 *     the bundle uses, so consumers see one coherent persistence layout;
 *   - if a DataStore was passed to the sandbox, our IDB shim takes the
 *     write; otherwise we fall through to happy-dom's in-memory IDB and
 *     things still work in tests.
 *
 * Usage:
 *
 *   await idbPut("snapcap", "fidelius", "identity", blob);
 *   const blob = await idbGet<MyBlob>("snapcap", "fidelius", "identity");
 *   await idbDelete("snapcap", "fidelius", "identity");
 *
 * Each call opens the database with the named object store, runs one
 * op, and waits for the transaction to settle. The shim is cheap so we
 * don't bother caching the IDBDatabase across calls.
 */
import { getSandbox } from "../shims/runtime.ts";

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
 * Resolve the sandbox's `indexedDB` global. With a DataStore configured
 * this is our shim; without one it's happy-dom's default. We tolerate
 * either shape — the property surface we use is identical.
 */
function getIDB(): MiniFactory {
  const sb = getSandbox();
  const idb = sb.getGlobal<MiniFactory>("indexedDB");
  if (!idb) throw new Error("indexedDB is not available on the sandbox");
  return idb;
}

/**
 * Open `dbName`, ensure `storeName` exists (creates it via the upgrade
 * callback on first use), and resolve the database handle. Each call
 * uses a fresh `version=1` open — for an existing store the upgrade
 * branch never fires.
 */
function openDb(dbName: string, storeName: string): Promise<MiniDatabase> {
  const idb = getIDB();
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

/** Run a single object-store op inside a transaction and wait for completion. */
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

/** Read a JSON-decoded value at the given (db, store, key). Undefined if absent. */
export async function idbGet<T = unknown>(
  dbName: string,
  storeName: string,
  key: string,
): Promise<T | undefined> {
  const db = await openDb(dbName, storeName);
  return runOp<T | undefined>(db, storeName, "readonly", (s) => s.get(key));
}

/** Write `value` (JSON-encoded) at the given (db, store, key). */
export async function idbPut(
  dbName: string,
  storeName: string,
  key: string,
  value: unknown,
): Promise<void> {
  const db = await openDb(dbName, storeName);
  await runOp<unknown>(db, storeName, "readwrite", (s) => s.put(value, key));
}

/** Delete the entry at the given (db, store, key). No-op if absent. */
export async function idbDelete(
  dbName: string,
  storeName: string,
  key: string,
): Promise<void> {
  const db = await openDb(dbName, storeName);
  await runOp<unknown>(db, storeName, "readwrite", (s) => s.delete(key));
}
