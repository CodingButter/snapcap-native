/**
 * Install browser-API shims on Node's globalThis so Snap's bundle can run.
 *
 * Uses happy-dom for the bulk of the DOM surface (document, HTMLElement,
 * fetch, Headers, etc.) and layers our own shims on top for the Snap-
 * specific bits (`navigator.userAgent`, the `chrome` global,
 * `performance.now`, etc.).
 *
 * Idempotent — calling twice is a no-op.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DataStore } from "../storage/data-store.ts";
import { StorageShim } from "../storage/storage-shim.ts";

let installed = false;

export type InstallShimOpts = {
  /** Page URL the shim pretends to be on. Default www.snapchat.com/web. */
  url?: string;
  /** UA string. Default matches our SDK's MacOS Chrome 147 fingerprint. */
  userAgent?: string;
  /** Width of the (virtual) viewport. Default 1440. */
  viewportWidth?: number;
  /** Height of the (virtual) viewport. Default 900. */
  viewportHeight?: number;
  /**
   * Backing DataStore for localStorage + sessionStorage shims.
   * If omitted, happy-dom's default in-memory storage is used (data lost
   * on process exit). Pass a FileDataStore to persist across runs.
   */
  dataStore?: DataStore;
};

export function installShims(opts: InstallShimOpts = {}): void {
  if (process.env.SNAPCAP_TRACE_SHIMS) {
    const e = new Error();
    process.stderr.write(`[shims] installShims(${opts.url ?? "default"}) installed=${installed}\n  ${e.stack?.split("\n").slice(2, 5).join("\n  ")}\n`);
  }
  if (installed) return;
  installed = true;

  const url = opts.url ?? "https://www.snapchat.com/web";
  const userAgent =
    opts.userAgent ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
  const width = opts.viewportWidth ?? 1440;
  const height = opts.viewportHeight ?? 900;

  GlobalRegistrator.register({
    url,
    width,
    height,
    settings: {
      navigator: { userAgent },
    },
  });

  const g = globalThis as unknown as Record<string, unknown>;

  // If a DataStore was provided, replace happy-dom's default in-memory
  // localStorage/sessionStorage with shims that persist into it.
  // Snap's bundle then transparently reads/writes via window.localStorage
  // (or bare `localStorage`) and we capture the state across runs.
  if (opts.dataStore) {
    const localShim = new StorageShim(opts.dataStore, "local_");
    const sessionShim = new StorageShim(opts.dataStore, "session_");
    // happy-dom's Storage properties are read-only — must use defineProperty.
    Object.defineProperty(g, "localStorage", { value: localShim, writable: true, configurable: true });
    Object.defineProperty(g, "sessionStorage", { value: sessionShim, writable: true, configurable: true });
    const win = g.window as Record<string, unknown> | undefined;
    if (win) {
      Object.defineProperty(win, "localStorage", { value: localShim, writable: true, configurable: true });
      Object.defineProperty(win, "sessionStorage", { value: sessionShim, writable: true, configurable: true });
    }
  }

  // Snap's bundle commonly checks for the `chrome` global (Chrome runtime
  // hooks). Provide a minimal stub.
  if (!g.chrome) {
    g.chrome = {
      runtime: {},
      app: {},
      csi: () => ({}),
      loadTimes: () => ({}),
    };
  }

  // Some bundles check `requestIdleCallback` exists.
  if (typeof g.requestIdleCallback !== "function") {
    g.requestIdleCallback = (cb: (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void) =>
      setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0);
    g.cancelIdleCallback = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  }

  // Worker-only globals: Snap's messaging WASM worker calls importScripts
  // and uses the WorkerGlobalScope `self`. Stub them so worker bundles can
  // load (we'll wire real semantics later).
  if (typeof g.importScripts !== "function") {
    g.importScripts = () => {};
  }

  // CacheStorage — the chat bundle's WASM init touches `caches.open(...)`
  // for offline asset caching. happy-dom doesn't ship it. Provide a no-op
  // that returns empty Cache objects so calls succeed without persisting.
  if (typeof g.caches === "undefined") {
    const emptyCache = {
      match: async () => undefined,
      add: async () => undefined,
      addAll: async () => undefined,
      put: async () => undefined,
      delete: async () => false,
      keys: async () => [],
      matchAll: async () => [],
    };
    g.caches = {
      open: async () => emptyCache,
      has: async () => false,
      delete: async () => false,
      keys: async () => [],
      match: async () => undefined,
    };
  }
}

export function isShimInstalled(): boolean {
  return installed;
}

export async function uninstallShims(): Promise<void> {
  if (!installed) return;
  await GlobalRegistrator.unregister();
  installed = false;
}
