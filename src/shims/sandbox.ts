/**
 * Isolated browser-API sandbox for Snap's bundles.
 *
 * Strategy:
 *   1. Construct a happy-dom `Window` for its DOM + browser globals
 *      (document, fetch, localStorage, history, navigator, …).
 *   2. Create a fresh empty `vm.Context` so V8 fills it with built-ins
 *      (Object, Array, Promise, WebAssembly, JSON, …). happy-dom's Window
 *      is designed to be installed via GlobalRegistrator and exposes
 *      `Object`/`Array` as `undefined` instance stubs — wrapping it
 *      directly in `vm.createContext` would *strip* V8's built-ins.
 *   3. Project happy-dom's browser-side properties onto the vm context's
 *      global, then layer Snap-bundle shims (chrome, requestIdleCallback,
 *      caches, importScripts, DataStore-backed Storage) on top.
 *
 * Bundle source eval'd via `runInContext` sees that synthesized global
 * as its `globalThis`/`self`/`window` — bare references to `localStorage`,
 * `document`, `fetch`, etc. resolve to happy-dom's properties; `Object`/
 * `Array`/`Promise` resolve to V8 built-ins; assignments to `globalThis.X`
 * land on the synthesized global, where SDK code can read them back via
 * `getGlobal(key)`. Consumer code outside the sandbox is unaffected.
 */
import vm from "node:vm";
import { Window } from "happy-dom";
import type { DataStore } from "../storage/data-store.ts";
import type { ThrottleConfig } from "../transport/throttle.ts";
import { getOrCreateJar } from "./cookie-jar.ts";
import { SDK_SHIMS, type ShimContext } from "./index.ts";

export type SandboxOpts = {
  /** Page URL the Window pretends to be on. Default www.snapchat.com/web. */
  url?: string;
  /** UA string. Default matches the SDK's MacOS Chrome 147 fingerprint. */
  userAgent?: string;
  /** Width of the (virtual) viewport. Default 1440. */
  viewportWidth?: number;
  /** Height of the (virtual) viewport. Default 900. */
  viewportHeight?: number;
  /** Persistent backing for localStorage / sessionStorage shims. */
  dataStore?: DataStore;
  /** Optional opt-in HTTP throttling. Default: no throttle (browser-cadence). */
  throttle?: ThrottleConfig;
};

/** happy-dom Window properties we copy onto the sandbox global. */
const BROWSER_PROJECTED_KEYS = [
  // Core DOM + page
  "document", "location", "history", "navigator", "performance",
  // Networking
  "fetch", "Headers", "Request", "Response", "FormData",
  "XMLHttpRequest", "WebSocket", "EventSource",
  // Storage primitives (we override local/session below)
  "localStorage", "sessionStorage", "indexedDB",
  // Encoding / web crypto
  "atob", "btoa", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
  "crypto",
  // Timers (happy-dom provides Node-bound versions)
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  // Event types the bundle constructs
  "Event", "EventTarget", "CustomEvent", "MessageEvent", "ErrorEvent",
  // DOM constructors used by React mount paths
  "Element", "HTMLElement", "Node", "Document",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  // Misc browser globals the bundle pokes at
  "matchMedia", "scrollTo", "scrollBy", "open", "close", "alert",
  "confirm", "prompt", "getComputedStyle",
];

export class Sandbox {
  /** Synthesized vm-realm global; this is what bundle code sees as `globalThis`. */
  readonly window: Record<string, unknown>;
  readonly context: vm.Context;
  /** happy-dom Window — kept for direct DOM access (e.g. injecting #root). */
  private readonly hdWindow: Window;

  constructor(opts: SandboxOpts = {}) {
    const url = opts.url ?? "https://www.snapchat.com/web";
    const userAgent =
      opts.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
    const width = opts.viewportWidth ?? 1440;
    const height = opts.viewportHeight ?? 900;

    // CookieContainer prototype patch must happen BEFORE constructing the
    // Window — happy-dom news up the per-Window CookieContainer inside
    // `new Window(...)` (it lives on a private `#browserFrame.page.context`
    // chain), and our patch needs to be visible on that instance so its
    // outgoing-fetch path (FetchRequestHeaderUtility.getRequestHeaders)
    // pulls cookies from the DataStore-backed jar instead of an in-memory
    // array. We satisfy that ordering by running ONLY the CookieContainer
    // shim before the Window is constructed; the rest of `SDK_SHIMS` runs
    // after the Window + vm context exist (see end of constructor).
    //
    // The shared cookie jar is hydrated synchronously here so all shims
    // installed below see the same instance via `ShimContext.jar`.
    let shimCtx: ShimContext | undefined;
    if (opts.dataStore) {
      shimCtx = {
        dataStore: opts.dataStore,
        userAgent,
        jar: getOrCreateJar(opts.dataStore),
      };
      // CookieContainerShim patches the prototype; safe to run before
      // `this.hdWindow` exists — its install ignores the sandbox arg.
      SDK_SHIMS[0]!.install(this, shimCtx);
    }

    this.hdWindow = new Window({
      url,
      width,
      height,
      settings: { navigator: { userAgent } },
    });

    // Empty sandbox object → V8 fills the new context's global with built-ins
    // (Object, Array, Promise, WebAssembly, JSON, …) before any of our own
    // properties land.
    this.context = vm.createContext({});
    const ctxGlobal = vm.runInContext("globalThis", this.context) as Record<string, unknown>;
    this.window = ctxGlobal;

    // Project happy-dom browser-side properties onto the vm global. We
    // copy *every* defined property from happy-dom Window — explicitly
    // enumerating only the keys we know about means the bundle silently
    // gets `undefined` for things like `BroadcastChannel`, which can
    // cause the WASM to busy-wait when it expects a callback.
    //
    // Skip the keys happy-dom defines as `undefined` instance stubs
    // (Object/Array/Promise etc.) — those would shadow V8's built-ins.
    const hd = this.hdWindow as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(hd)) {
      if (key in ctxGlobal) continue; // don't shadow built-ins V8 already provided
      const v = hd[key];
      if (v === undefined || v === null) continue;
      try {
        ctxGlobal[key] = v;
      } catch {
        /* some props are non-configurable on hd Window — skip */
      }
    }
    // The keys above also have to override a few specific projections
    // (e.g. localStorage gets a DataStore-backed shim below, fetch is
    // already happy-dom's), so explicit overrides go AFTER this.

    // Bundle code does `self.webpackChunk_*`, `window.foo`, `globalThis.bar`
    // interchangeably. Make all three resolve to the same object.
    ctxGlobal.window = ctxGlobal;
    ctxGlobal.self = ctxGlobal;
    ctxGlobal.top = ctxGlobal;
    ctxGlobal.parent = ctxGlobal;
    ctxGlobal.frames = ctxGlobal;

    // Run the rest of `SDK_SHIMS` (skip [0] CookieContainerShim — already
    // ran above pre-Window). Each shim is responsible for its own I/O
    // boundary; the canonical list + ordering is in `./index.ts`. Without
    // a DataStore we fall through to happy-dom's in-memory defaults for
    // localStorage / sessionStorage / indexedDB / document.cookie / WS.
    if (shimCtx) {
      for (let i = 1; i < SDK_SHIMS.length; i++) {
        SDK_SHIMS[i]!.install(this, shimCtx);
      }
    }

    // Snap-bundle environment: chrome runtime stub, idle-callback,
    // worker-only globals, CacheStorage stub. Install directly onto the
    // vm global — never touch host globalThis.
    if (!ctxGlobal.chrome) {
      ctxGlobal.chrome = { runtime: {}, app: {}, csi: () => ({}), loadTimes: () => ({}) };
    }
    if (typeof ctxGlobal.requestIdleCallback !== "function") {
      ctxGlobal.requestIdleCallback = (cb: (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void) =>
        setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0);
      ctxGlobal.cancelIdleCallback = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    }
    if (typeof ctxGlobal.importScripts !== "function") {
      ctxGlobal.importScripts = () => {};
    }
    // EXPERIMENT: minimal Worker stub. Records construction args, emits
    // no events, terminate is a no-op. Goal: see if the bundle's
    // wasm.initialize() limps to a usable state with a fake worker, or
    // if it requires a real one. If the bundle writes workerProxy into
    // state.wasm regardless, the syncFriends gate may pass even with a
    // dud worker; if loadWasm gates on a real bridge, we'll see it throw.
    // V8's vm.Context exposes WebAssembly without the streaming helper —
    // browsers and Node's main realm both ship it, but the sandbox realm
    // doesn't. The chat WASM session bring-up calls `instantiateStreaming`,
    // so polyfill it using sandbox-realm `WebAssembly.instantiate` to keep
    // returned Instance/Module objects in the right realm.
    {
      const sbWA = ctxGlobal.WebAssembly as undefined | {
        instantiateStreaming?: unknown;
        instantiate: (bytes: BufferSource, imports?: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
      };
      if (sbWA && typeof sbWA.instantiateStreaming !== "function") {
        (sbWA as { instantiateStreaming: typeof WebAssembly.instantiateStreaming }).instantiateStreaming =
          async (source, imports) => {
            const resp = await source;
            const buf = await resp.arrayBuffer();
            return sbWA.instantiate(buf, imports);
          };
      }
    }
    // CacheStorage fallback. The real DataStore-backed implementation is
    // installed by `CacheStorageShim` (see `./index.ts`) when a DataStore
    // is configured — it overwrites this stub. With no DataStore the
    // SDK_SHIMS loop above is skipped, so this no-op stub is what bundle
    // code sees, matching the legacy "writes vanish" behaviour we had
    // before the shim landed.
    if (typeof ctxGlobal.caches === "undefined") {
      const emptyCache = {
        match: async () => undefined, add: async () => undefined,
        addAll: async () => undefined, put: async () => undefined,
        delete: async () => false, keys: async () => [], matchAll: async () => [],
      };
      ctxGlobal.caches = {
        open: async () => emptyCache, has: async () => false,
        delete: async () => false, keys: async () => [], match: async () => undefined,
      };
    }
  }

  /**
   * Eval source code in the sandbox. The code's `globalThis`, bare global
   * references (`localStorage`, `document`, etc.), and `this` at the top
   * level all resolve to the synthesized vm global.
   */
  runInContext(source: string, filename?: string): unknown {
    return vm.runInContext(source, this.context, filename ? { filename } : undefined);
  }

  /** Read a property from the sandbox global — for SDK code that needs
   *  to access bundle-registered artifacts (Module objects, webpack maps). */
  getGlobal<T = unknown>(key: string): T | undefined {
    return this.window[key] as T | undefined;
  }

  /** Set a property on the sandbox global — for pre-staging values
   *  the bundle's eval needs to find at the top level. */
  setGlobal(key: string, value: unknown): void {
    this.window[key] = value;
  }

  /** happy-dom document, for direct DOM mutation (e.g. injecting a #root
   *  div before React mounts during a bundle's top-level eval). */
  get document(): unknown {
    return (this.hdWindow as unknown as { document: unknown }).document;
  }

  /**
   * Copy bytes into a vm-realm `Uint8Array` so bundle code recognises it
   * as a "real" `Uint8Array`. Cross-realm `instanceof Uint8Array` fails
   * (each vm context has its own typed-array constructors), and bundle
   * protobuf decoders throw `Error("illegal buffer")` on the foreign view.
   *
   * Use this any time SDK (host-realm) code hands raw bytes into a bundle
   * function — gRPC response decode, Embind argument marshalling, etc.
   */
  toVmU8(bytes: Uint8Array | ArrayBufferView): Uint8Array {
    const VmU8 = this.runInContext("Uint8Array") as Uint8ArrayConstructor;
    const src = bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new VmU8(src.byteLength);
    out.set(src);
    return out;
  }
}
