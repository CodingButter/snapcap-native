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
import { join } from "node:path";
import vm from "node:vm";
import { Window } from "happy-dom";
import type { DataStore } from "../storage/data-store.ts";
import type {
  KeyManagerStatics,
  StandaloneChatModule,
  StandaloneChatWreq,
} from "../auth/fidelius-mint.ts";
import { createThrottle, type ThrottleConfig, type ThrottleGate } from "../transport/throttle.ts";
import { getOrCreateJar } from "./cookie-jar.ts";
import { SDK_SHIMS, type ShimContext } from "./index.ts";
import type { WebpackCaptureState } from "./webpack-capture.ts";
import { installWorkerShim } from "./worker.ts";

/**
 * Construction options for a {@link Sandbox}.
 *
 * @internal
 */
export type SandboxOpts = {
  /**
   * Page URL the Window pretends to be on.
   *
   * @defaultValue `https://www.snapchat.com/web`
   */
  url?: string;
  /**
   * UA string. Default matches the SDK's MacOS Chrome 147 fingerprint.
   */
  userAgent?: string;
  /**
   * Width of the (virtual) viewport.
   *
   * @defaultValue `1440`
   */
  viewportWidth?: number;
  /**
   * Height of the (virtual) viewport.
   *
   * @defaultValue `900`
   */
  viewportHeight?: number;
  /** Persistent backing for localStorage / sessionStorage shims. */
  dataStore?: DataStore;
  /**
   * Filesystem path to the on-disk vendored Snap bundle. Used by the
   * {@link installWorkerShim Worker shim} to resolve worker chunks
   * (`<bundleDir>/cf-st.sc-cdn.net/dw/<basename>`). Defaults to
   * `vendor/snap-bundle` relative to this package's source tree.
   */
  bundleDir?: string;
  /**
   * Optional opt-in HTTP throttling. Default: no throttle (browser-cadence).
   *
   * Accepts EITHER a `ThrottleConfig` (per-instance — Sandbox builds its
   * own gate from the config) OR a pre-built `ThrottleGate` function
   * (shared across instances — pass the same gate to multiple Sandboxes
   * to coordinate their aggregate request rate). See
   * `transport/throttle.ts` for the full picture.
   */
  throttle?: ThrottleConfig | ThrottleGate;
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

// Process-level counters for the "multi-instance with per-instance
// throttle" foot-gun warning. Tracking is cheap (two integers) and the
// warning fires at most once per process — opt-out via env var.
let _sandboxesConstructed = 0; // MULTI-INSTANCE-SAFE: process-wide counter, diagnostics only
let _sandboxesUsingPerInstanceThrottle = 0; // MULTI-INSTANCE-SAFE: process-wide counter, diagnostics only
let _multiInstanceWarningEmitted = false; // MULTI-INSTANCE-SAFE: once-per-process warning latch

function maybeWarnMultiInstancePerInstanceThrottle(): void {
  if (_multiInstanceWarningEmitted) return;
  if (process.env.SNAPCAP_SUPPRESS_THROTTLE_WARNING === "1") return;
  if (_sandboxesConstructed < 2) return;
  if (_sandboxesUsingPerInstanceThrottle < 2) return;
  _multiInstanceWarningEmitted = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[snapcap/native] WARNING: detected multiple SnapcapClient instances each using a per-instance " +
    "throttle config. Their aggregate request rate scales with N — N=5 with the default 1500ms " +
    "AddFriends rule = 5 mutations per 1500ms aggregate, which Snap may flag as anti-spam. " +
    "For multi-tenant deployments, build a single shared gate via `createSharedThrottle(config)` " +
    "and pass the SAME gate into every client (`throttle: gate`). " +
    "Suppress this warning with SNAPCAP_SUPPRESS_THROTTLE_WARNING=1 if intentional.",
  );
}

/**
 * Isolated browser-API sandbox for Snap's bundles.
 *
 * Constructs an empty `vm.Context`, projects happy-dom Window properties
 * onto it, and layers SDK shims (cookies, storage, fetch/XHR, WebAssembly
 * polyfills) on top. Each `SnapcapClient` owns its own `Sandbox` —
 * isolation lives at the V8 vm.Context boundary.
 *
 * @internal Lower-level than the public `SnapcapClient` constructor.
 * Consumers shouldn't need to construct a `Sandbox` directly.
 */
export class Sandbox {
  /**
   * Synthesized vm-realm global; this is what bundle code sees as
   * `globalThis`.
   *
   * @internal
   */
  readonly window: Record<string, unknown>;
  /** @internal */
  readonly context: vm.Context;
  /**
   * happy-dom Window — kept for direct DOM access (e.g. injecting #root)
   * and reachable by shims that need to walk happy-dom's BrowserContext
   * chain (e.g. `CookieContainerShim` reaches the per-Window
   * CookieContainer through it).
   *
   * @internal
   */
  readonly hdWindow: Window;

  /**
   * Per-instance throttle gate. Bundle-driven HTTP layers (`shims/fetch`,
   * `shims/xml-http-request`) and host-realm `transport/native-fetch` all
   * await `sandbox.throttleGate(url)` before issuing a wire request when
   * given access to the sandbox. No-op by default; configured from
   * `opts.throttle` in the constructor.
   *
   * Per-instance (not module-level) so two Sandboxes can coexist with
   * independent throttle configs without stepping on each other.
   *
   * @internal
   */
  readonly throttleGate: (url: string) => Promise<void>;

  // ─── Per-instance bundle bring-up caches ─────────────────────────────
  // These caches USED to live as module-level singletons in the loaders,
  // making two Sandboxes impossible (the second would silently skip its
  // bundle eval because the first set the flag). Moved here so each
  // Sandbox owns its own bring-up state. Loaders own the type semantics;
  // this class just provides typed storage slots.

  /**
   * Resolved kameleon Module + finalize() context (bundle/accounts-loader).
   *
   * @internal
   */
  kameleonBoot?: Promise<unknown>;
  /**
   * True once the chat bundle's main JS has been eval'd in this sandbox.
   *
   * @internal
   */
  chatBundleLoaded = false;
  /**
   * True once the chat bundle's webpack runtime has been eval'd in this
   * sandbox.
   *
   * @internal
   */
  chatRuntimeLoaded = false;
  /**
   * Resolved chat-WASM moduleEnv with Embind classes (bundle/chat-wasm-boot).
   *
   * @internal
   */
  chatWasmBoot?: Promise<unknown>;
  /**
   * Resolved standalone Fidelius mint realm — a SECOND, isolated chat-WASM
   * instance booted in its own `vm.Context` with neutered browser stubs.
   * Owned by `auth/fidelius-mint.ts`; cached here so two `SnapcapClient`
   * instances each mint their own identity in their own realm instead of
   * sharing a process-singleton.
   *
   * @internal
   */
  fideliusMintBoot?: Promise<{
    km: KeyManagerStatics;
    moduleEnv: StandaloneChatModule;
    context: vm.Context;
    wreq: StandaloneChatWreq;
  }>;

  /**
   * Per-sandbox webpack-capture accumulator. Owned by
   * `shims/webpack-capture.ts:installWebpackCapture`; cached here so
   * repeated installs on the same Sandbox return the same maps and two
   * Sandboxes never share a captured-modules accumulator.
   *
   * @internal
   */
  webpackCapture?: WebpackCaptureState;

  constructor(opts: SandboxOpts = {}) {
    // Accept either a pre-built gate (shared across instances) or a config
    // (per-instance — build gate from config). Function = gate; object = config.
    const isPerInstanceThrottle = opts.throttle !== undefined && typeof opts.throttle !== "function";
    this.throttleGate = typeof opts.throttle === "function"
      ? opts.throttle
      : createThrottle(opts.throttle);

    // Track for the multi-instance + per-instance-throttle foot-gun warning.
    _sandboxesConstructed++;
    if (isPerInstanceThrottle) _sandboxesUsingPerInstanceThrottle++;
    maybeWarnMultiInstancePerInstanceThrottle();
    const url = opts.url ?? "https://www.snapchat.com/web";
    const userAgent =
      opts.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
    const width = opts.viewportWidth ?? 1440;
    const height = opts.viewportHeight ?? 900;

    // The CookieContainer prototype patch (in `CookieContainerShim`) is
    // process-global + idempotent + STATELESS — the patched methods
    // dispatch via a per-instance WeakMap keyed by the calling
    // CookieContainer (`this`). That binding happens via
    // `bindCookieContainer(hdWindow, jar, store)` AFTER `new Window(...)`
    // creates the per-Window CookieContainer. Order rationale: the patch
    // is dynamic prototype lookup, so patching before or after Window
    // construction is equivalent — but the per-instance binding obviously
    // needs the Window (and its CookieContainer) to exist first.
    //
    // The shared cookie jar is hydrated synchronously here so all shims
    // see the same instance via `ShimContext.jar`.
    let shimCtx: ShimContext | undefined;
    if (opts.dataStore) {
      shimCtx = {
        dataStore: opts.dataStore,
        userAgent,
        jar: getOrCreateJar(opts.dataStore),
      };
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

    // Run all of `SDK_SHIMS` (CookieContainerShim included, since its
    // per-instance binding step needs `this.hdWindow`). Each shim is
    // responsible for its own I/O boundary; the canonical list + ordering
    // is in `./index.ts`. Without a DataStore we fall through to
    // happy-dom's in-memory defaults for localStorage / sessionStorage /
    // indexedDB / document.cookie / WS.
    if (shimCtx) {
      for (const shim of SDK_SHIMS) {
        shim.install(this, shimCtx);
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
    // Worker class shim — synchronous in-process Web Worker simulator.
    // Snap's bundle calls `new Worker(blobUrl)` from `state.wasm.initialize()`
    // to spawn a thread that boots the messaging WASM. We satisfy the
    // contract by running the worker chunk's JS in a small isolated
    // scope inside this same realm. See `./worker.ts` for the protocol
    // bridge details.
    const bundleDir = opts.bundleDir ?? join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
    installWorkerShim(this, { bundleDir });

    // (Reverted) MessageChannel/MessagePort exposure — caused auth to hang
    // at bundle load time. Need narrower exposure path, possibly only at
    // the time wasm.initialize fires.
    // this.setGlobal("MessageChannel", MessageChannel);
    // this.setGlobal("MessagePort", MessagePort);
  }

  /**
   * Eval source code in the sandbox. The code's `globalThis`, bare global
   * references (`localStorage`, `document`, etc.), and `this` at the top
   * level all resolve to the synthesized vm global.
   *
   * @internal
   * @param source - JavaScript source to evaluate
   * @param filename - optional filename for stack-trace attribution
   * @returns whatever the source's last expression evaluates to
   */
  runInContext(source: string, filename?: string): unknown {
    return vm.runInContext(source, this.context, filename ? { filename } : undefined);
  }

  /**
   * Read a property from the sandbox global — for SDK code that needs to
   * access bundle-registered artifacts (Module objects, webpack maps).
   *
   * @internal
   * @param key - global property name
   * @returns the value stored on the sandbox global, or `undefined`
   */
  getGlobal<T = unknown>(key: string): T | undefined {
    return this.window[key] as T | undefined;
  }

  /**
   * Set a property on the sandbox global — for pre-staging values the
   * bundle's eval needs to find at the top level.
   *
   * @internal
   * @param key - global property name
   * @param value - value to assign
   */
  setGlobal(key: string, value: unknown): void {
    this.window[key] = value;
  }

  /**
   * happy-dom document, for direct DOM mutation (e.g. injecting a `#root`
   * div before React mounts during a bundle's top-level eval).
   *
   * @internal
   */
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
   *
   * @internal
   * @param bytes - host-realm typed-array view
   * @returns sandbox-realm `Uint8Array` containing the same bytes
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
