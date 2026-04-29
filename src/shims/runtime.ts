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
};

export function installShims(opts: InstallShimOpts = {}): void {
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

  // Snap's bundle commonly checks for the `chrome` global (Chrome runtime
  // hooks). Provide a minimal stub.
  const g = globalThis as unknown as Record<string, unknown>;
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
}

export function isShimInstalled(): boolean {
  return installed;
}

export async function uninstallShims(): Promise<void> {
  if (!installed) return;
  await GlobalRegistrator.unregister();
  installed = false;
}
