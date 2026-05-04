/**
 * Mint a real Fidelius identity by booting a SECOND, isolated copy of the
 * chat-bundle Emscripten WASM.
 *
 * Why a second instance: the bundle's main top-level eval auto-boots its
 * own copy of the chat WASM into the captured `__SNAPCAP_CHAT_MODULE`.
 * That instance lives in a realm where the Worker shim is neutered (so
 * messaging session bring-up doesn't loop in metrics + sentry traffic),
 * and the noop'd worker bridge corrupts internal state such that the
 * static Embind call `e2ee_E2EEKeyManager.generateKeyInitializationRequest`
 * aborts. A SECOND, independent WASM instance booted in a fresh
 * vm.Context has a clean Embind realm (Embind state is per-realm — see
 * `chat-wasm-boot.ts:14-19`) and a moduleEnv WE control end-to-end, so
 * the static mint succeeds.
 *
 * Approach (mirrors the legacy commit d63b452):
 *   1. Create a fresh vm.Context with the minimum globals the bundle's
 *      runtime + main top-level need to register their factories without
 *      requiring a full happy-dom Window (the mint path doesn't touch
 *      `document` / `fetch` / Workers — it's pure WASM crypto).
 *   2. Eval the chat-bundle webpack runtime (9989a…js) — patched to leak
 *      `__webpack_require__` as `globalThis.__snapcap_p`.
 *   3. Eval the chat-bundle main (9846a…js) — registers ~1488 module
 *      factories. Top-level throws on browser-only init paths; factories
 *      are registered BEFORE the throw so the wreq map is populated.
 *   4. Pull factory module 86818 and call it ourselves with our own
 *      moduleEnv that supplies the WASM bytes via `instantiateWasm`.
 *      Wait for `onRuntimeInitialized` to flip.
 *   5. Call `e2ee_E2EEKeyManager.generateKeyInitializationRequest(1)` —
 *      v10 ("TEN") shape, the only one Snap's server still accepts at
 *      first-login time.
 *
 * Boot cost: ~12 MB WASM compile + ~1488 webpack module registrations +
 * ~250ms init. Cached on the module-level `cachedMintBoot` promise so
 * repeat mints in the same process share one instance.
 *
 * @internal Auth-layer; called from `kickoffMessagingSession` in
 * `api/auth.ts`.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FideliusIdentity } from "../api/fidelius.ts";

type KeyManagerStatics = {
  generateKeyInitializationRequest: (algorithm: number) => GenerationResult;
};

type GenerationResult = {
  keyInfo: {
    identity: {
      cleartextPublicKey: object;
      cleartextPrivateKey: object;
      identityKeyId: { data: object };
      version: number;
    };
    rwk: { data: object };
  };
  request: object;
};

/** Cached boot result — one fresh-realm WASM instance per process. */
let cachedMintBoot: Promise<{ km: KeyManagerStatics }> | null = null;

/**
 * Produce a fresh {@link FideliusIdentity} from a fresh-realm WASM
 * instance. Lazy-boots the standalone WASM on first call; subsequent
 * calls reuse the cached instance.
 *
 * @throws if the WASM boot fails (missing bundle files, factory shape
 *   shifted, runtime init timeout) or the mint call aborts.
 */
export async function mintFideliusIdentity(): Promise<FideliusIdentity> {
  const { km } = await getOrBootKeyManager();
  // Algorithm 1 = "TEN" (v10) — matches what browsers send at first
  // login. Older algorithm 0 (v9) shape produces a request without the
  // wrapped RWK and Snap's server still accepts it but we standardise
  // on the current protocol.
  const result = km.generateKeyInitializationRequest(1);
  return {
    cleartextPublicKey: toBytes(result.keyInfo.identity.cleartextPublicKey),
    cleartextPrivateKey: toBytes(result.keyInfo.identity.cleartextPrivateKey),
    identityKeyId: toBytes(result.keyInfo.identity.identityKeyId.data),
    rwk: toBytes(result.keyInfo.rwk.data),
    version: result.keyInfo.identity.version,
  };
}

async function getOrBootKeyManager(): Promise<{ km: KeyManagerStatics }> {
  if (cachedMintBoot) return cachedMintBoot;
  cachedMintBoot = bootStandaloneMintWasm();
  // If the boot rejects, drop the cache so a retry can re-attempt.
  cachedMintBoot.catch(() => { cachedMintBoot = null; });
  return cachedMintBoot;
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
}

/**
 * Boot the chat-bundle messaging WASM in a clean vm.Context, returning a
 * handle to its `e2ee_E2EEKeyManager` static class. The fresh realm
 * guarantees clean Embind registration (no collision with the bundle's
 * own auto-instantiated Module).
 */
async function bootStandaloneMintWasm(): Promise<{ km: KeyManagerStatics }> {
  const bundleDir = defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");
  const runtimePath = join(chatDw, "9989a7c6c88a16ebf19d.js");
  const mainPath = join(chatDw, "9846a7958a5f0bee7197.js");
  const wasmPath = join(chatDw, "e4fa90570c4c2d9e59c1.wasm");

  // Minimal fresh realm. We deliberately AVOID happy-dom + the full SDK
  // shim stack because (a) we don't want any of the Worker / fetch /
  // storage shims that put the bundle's auto-instantiated Module into a
  // bad state, and (b) this realm only needs to live long enough to call
  // the WASM's static mint method — no DOM / network / storage required.
  //
  // V8 fills an empty `vm.createContext({})` with the standard built-ins
  // (Object, Array, Promise, WebAssembly, JSON, …); we add a small set
  // of browser-shaped globals the bundle's top-level eval probes for
  // BEFORE it throws on a missing browser-only API.
  const context = vm.createContext({});
  const ctxGlobal = vm.runInContext("globalThis", context) as Record<string, unknown>;
  // Self-aliases so `self.webpackChunk_*` / `globalThis.X` / `window.Y`
  // all resolve to the same object.
  ctxGlobal.self = ctxGlobal;
  ctxGlobal.window = ctxGlobal;
  ctxGlobal.top = ctxGlobal;

  // Stubs the bundle's runtime + main top-level reach for. These never
  // get exercised — they exist only so `typeof X === 'function'` checks
  // pass during the brief window before main throws.
  ctxGlobal.console = console;
  ctxGlobal.setTimeout = setTimeout as unknown as typeof setTimeout;
  ctxGlobal.clearTimeout = clearTimeout as unknown as typeof clearTimeout;
  ctxGlobal.setInterval = setInterval as unknown as typeof setInterval;
  ctxGlobal.clearInterval = clearInterval as unknown as typeof clearInterval;
  ctxGlobal.queueMicrotask = queueMicrotask;
  ctxGlobal.TextEncoder = TextEncoder;
  ctxGlobal.TextDecoder = TextDecoder;
  ctxGlobal.URL = URL;
  ctxGlobal.URLSearchParams = URLSearchParams;
  ctxGlobal.atob = atob;
  ctxGlobal.btoa = btoa;
  ctxGlobal.crypto = globalThis.crypto;
  ctxGlobal.performance = performance;
  // Bundle reads `location.href` at top-level — give it a string-shaped stub.
  ctxGlobal.location = {
    href: "https://www.snapchat.com/web",
    pathname: "/web",
    origin: "https://www.snapchat.com",
    protocol: "https:",
    host: "www.snapchat.com",
    hostname: "www.snapchat.com",
    search: "",
    hash: "",
  };
  // Minimal navigator stub — bundle reads `navigator.userAgent` early.
  ctxGlobal.navigator = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    language: "en-US",
    languages: ["en-US", "en"],
    platform: "MacIntel",
    onLine: true,
  };
  // Minimal document stub — top-level React mount paths probe these.
  // Returning `null` from createElement / getElementById is enough to
  // make the bundle's mount path throw cleanly (which we catch).
  ctxGlobal.document = {
    body: { innerHTML: "" },
    head: { appendChild: () => {} },
    createElement: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { style: {} },
    cookie: "",
  };
  // Stub fetch / XMLHttpRequest as unimplemented. The mint path never
  // touches the network — only the bundle's React-mount path does, and
  // that throws cleanly on first reach.
  ctxGlobal.fetch = () => {
    throw new Error("fetch unavailable in mint realm");
  };
  ctxGlobal.XMLHttpRequest = function XMLHttpRequest() {
    throw new Error("XMLHttpRequest unavailable in mint realm");
  };
  ctxGlobal.Worker = function Worker() {
    throw new Error("Worker unavailable in mint realm");
  };
  ctxGlobal.WebSocket = function WebSocket() {
    throw new Error("WebSocket unavailable in mint realm");
  };
  ctxGlobal.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  ctxGlobal.sessionStorage = ctxGlobal.localStorage;
  ctxGlobal.indexedDB = {
    open: () => ({}),
  };
  ctxGlobal.requestAnimationFrame = (cb: (ts: number) => void): number => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  };
  ctxGlobal.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as NodeJS.Timeout);
  };

  // Pre-stage real Buffer / fs onto the realm so the patched main bundle's
  // empty Node-stub modules (91903 → Buffer, 36675 → fs) can hand them
  // out when the bundle's top-level invokes the stubs.
  const fsModule = await import("node:fs");
  ctxGlobal.__snapcap_node_buffer = { Buffer };
  ctxGlobal.__snapcap_node_fs = fsModule;

  // ── Step 1: load the chat-bundle webpack runtime ────────────────────
  // Source-patch the closure-private `__webpack_require__` (named `o` in
  // the chat runtime) to leak as `globalThis.__snapcap_p` so we can
  // address modules by id from outside the runtime's IIFE.
  let runtimeSrc = readFileSync(runtimePath, "utf8");
  if (!runtimeSrc.includes("o.m=n,o.amdO={}")) {
    throw new Error(
      "fidelius-mint: chat-bundle runtime patch site `o.m=n,o.amdO={}` not found — bundle version may have shifted",
    );
  }
  runtimeSrc = runtimeSrc.replace(
    "o.m=n,o.amdO={}",
    "globalThis.__snapcap_p=o,o.m=n,o.amdO={}",
  );
  const runtimeWrapped =
    `(function(module, exports, require) {\n` +
    runtimeSrc +
    `\n})({ exports: {} }, {}, function() { throw new Error("require not available (chat runtime)"); });`;
  try {
    vm.runInContext(runtimeWrapped, context, { filename: "chat-bundle-runtime.js" });
  } catch {
    // Top-level eval often throws on browser-only bring-up; module map
    // lands BEFORE the throw, which is all we need.
  }

  // ── Step 2: load the chat-bundle main (registers factory 86818) ─────
  let mainSrc = readFileSync(mainPath, "utf8");
  // Same Node-stub swaps as `chat-loader.ts` so the main top-level can
  // resolve real Buffer + fs when it pokes into modules 91903 / 36675.
  mainSrc = mainSrc.replace(
    "91903(){}",
    "91903(e,t){t.Buffer=globalThis.__snapcap_node_buffer.Buffer}",
  );
  mainSrc = mainSrc.replace(
    "36675(){}",
    "36675(e,t){Object.assign(t,globalThis.__snapcap_node_fs)}",
  );
  // CRITICAL: do NOT apply the `__SNAPCAP_CHAT_MODULE=o` source-patch from
  // chat-loader. We don't want the bundle to auto-instantiate its own
  // copy in this realm — we'll call the factory ourselves below with a
  // moduleEnv we control. The auto-instantiation path runs as part of
  // the main top-level eval; the eval throws on browser-only init paths
  // BEFORE that auto-instantiation can fire (empirically verified in
  // d63b452 — factories register, throw fires, factory map ready for
  // direct call).
  const mainWrapped =
    `(function(module, exports, require) {\n` +
    mainSrc +
    `\n})({ exports: {} }, {}, function() { throw new Error("require not available (chat main)"); });`;
  try {
    vm.runInContext(mainWrapped, context, { filename: "chat-bundle-main.js" });
  } catch {
    // Expected — main does top-level browser-only work that throws on
    // our minimal stubs. Module factories registered before the throw.
  }

  const wreq = ctxGlobal.__snapcap_p as
    | { (id: string): unknown; m: Record<string, Function> }
    | undefined;
  if (!wreq) {
    throw new Error(
      "fidelius-mint: chat-bundle webpack runtime did not expose __snapcap_p — runtime patch may have failed to apply",
    );
  }
  if (!wreq.m["86818"]) {
    throw new Error(
      "fidelius-mint: chat-bundle module 86818 (Emscripten Module factory) not registered — main eval may have thrown too early",
    );
  }

  // ── Step 3: resolve module 86818's factory (Emscripten Module ctor) ─
  const factoryMod = wreq("86818") as { A?: Function; default?: Function } & Record<string, unknown>;
  const factory = (factoryMod.A ?? factoryMod.default ?? factoryMod) as Function;
  if (typeof factory !== "function") {
    throw new Error(
      `fidelius-mint: chat-bundle module 86818 did not yield a callable factory; shape: ${Object.keys(factoryMod).join(",")}`,
    );
  }

  // ── Step 4: read WASM bytes + invoke factory with our own moduleEnv ─
  const wasmBytes = readFileSync(wasmPath);

  let runtimeInitDone = false;
  let initError: unknown = null;
  const moduleEnv: Record<string, unknown> = {
    onRuntimeInitialized: (): void => {
      runtimeInitDone = true;
    },
    instantiateWasm: (
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance, mod?: WebAssembly.Module) => void,
    ): unknown => {
      // WebAssembly is realm-independent; instantiate against the host's
      // copy and hand the resulting instance back via the callback.
      WebAssembly.instantiate(wasmBytes, imports).then(
        (res) => {
          successCallback(res.instance, res.module);
        },
        (err) => {
          initError = err;
        },
      );
      return {}; // non-falsy return tells Emscripten "I'll call you back"
    },
    onAbort: (reason: unknown): void => {
      initError = new Error(`Fidelius WASM aborted during init: ${String(reason)}`);
    },
    print: (): void => {},
    printErr: (s: string): void => {
      // Surface WASM stderr only when explicitly traced — Emscripten is
      // chatty about non-fatal CHECK warnings during init.
      if (process.env.SNAPCAP_FIDELIUS_WASM_TRACE === "1") {
        process.stderr.write(`[fidelius-mint wasm-err] ${s}\n`);
      }
    },
    locateFile: (name: string): string => name,
  };

  factory(moduleEnv);

  // The Emscripten `Module.ready` Promise doesn't always resolve cleanly
  // through our minimal stubs; poll the runtime-init flag instead.
  const startedAt = Date.now();
  while (!runtimeInitDone) {
    if (initError) throw initError;
    if (Date.now() - startedAt > 30_000) {
      throw new Error("fidelius-mint: WASM init timed out (>30s waiting for onRuntimeInitialized)");
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  const km = (moduleEnv as { e2ee_E2EEKeyManager?: KeyManagerStatics }).e2ee_E2EEKeyManager;
  if (!km || typeof km.generateKeyInitializationRequest !== "function") {
    throw new Error(
      "fidelius-mint: WASM did not expose e2ee_E2EEKeyManager.generateKeyInitializationRequest — Embind shape may have shifted",
    );
  }
  return { km };
}

/**
 * Coerce the WASM's bytes-like return shapes into a plain `Uint8Array`.
 *
 * Embind hands these back as either:
 *   - already-typed `Uint8Array`
 *   - plain `number[]` (Embind's default for `std::vector<uint8_t>` in
 *     some build configs)
 *   - dictionary-like `{0:n, 1:n, …, length:n}` (older Embind)
 */
function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  if (x && typeof x === "object") {
    const values = Object.values(x as Record<string, number>).filter(
      (v) => typeof v === "number",
    );
    return new Uint8Array(values);
  }
  throw new Error("fidelius-mint.toBytes: expected bytes-like, got " + typeof x);
}
