/**
 * Boot the chat-bundle Emscripten WASM (e4fa…wasm) which carries
 * Fidelius (1:1 E2E) and Kraken (group E2E) primitives.
 *
 * Approach mirrors auth/kameleon.ts:
 *   1. installShims (happy-dom + chrome stub)
 *   2. Load chat-bundle webpack runtime (9989a…js) with its closure
 *      private `o` patched to leak as globalThis.__snapcap_p.
 *   3. Load chat-bundle main (9846a…js) which registers ~80k modules.
 *   4. Resolve module 86818 (Emscripten Module factory).
 *   5. Pass our pre-fetched e4fa wasm bytes via instantiateWasm.
 *   6. Inspect the resolved Module object for Embind classes.
 *
 * Expected exposure once Module init resolves (per string scan):
 *   r.platform_utils_PlatformUtils.getBuildInfo()
 *   r.shims_Platform.{init, registerSerialTaskQueue, installErrorReporter,
 *                      installNonFatalReporter}
 *   r.config_ConfigurationRegistry.{setCircumstanceEngine, setCompositeConfig,
 *                                    setExperiments, setServerConfig,
 *                                    setTweaks, setUserPrefs}
 *   r.snapchat_messaging_FideliusEncryption (Embind class — exact name TBC)
 */
// IMPORTANT: snapshot native fetch BEFORE installShims replaces it
// with happy-dom's CORS-enforcing version.
import { nativeFetch } from "../src/transport/native-fetch.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../src/shims/runtime.ts";
import { installWebpackCapture } from "../src/shims/webpack-capture.ts";

const BUNDLE_DIR = join(import.meta.dirname, "..", "vendor", "snap-bundle");
const CHAT_DW = join(BUNDLE_DIR, "cf-st.sc-cdn.net", "dw");
const RUNTIME_PATH = join(CHAT_DW, "9989a7c6c88a16ebf19d.js");
const MAIN_PATH = join(CHAT_DW, "9846a7958a5f0bee7197.js");
const WASM_PATH = join(CHAT_DW, "e4fa90570c4c2d9e59c1.wasm");

console.log("[fidelius] installing shims…");
installShims({ url: "https://www.snapchat.com/web" });
installWebpackCapture();

// Chat bundle's top-level code mounts a React app into #root. happy-dom
// gives us a body but no children — provide a root container so React
// doesn't blow up during eval.
{
  const doc = (globalThis as unknown as { document?: { body?: { innerHTML: string } } }).document;
  if (doc?.body) {
    doc.body.innerHTML = '<div id="root"></div><div id="__next"></div>';
  }
}

console.log("[fidelius] loading chat-bundle webpack runtime…");
let runtimeSrc = readFileSync(RUNTIME_PATH, "utf8");
// Chat-bundle runtime uses `o` (not `p` like accounts). Patch the closure-
// private variable to leak as globalThis.__snapcap_p.
const PATCH_FROM = "o.m=n,o.amdO={}";
const PATCH_TO = "globalThis.__snapcap_p=o,o.m=n,o.amdO={}";
if (!runtimeSrc.includes(PATCH_FROM)) {
  throw new Error(`webpack runtime patch site not found: "${PATCH_FROM}"`);
}
runtimeSrc = runtimeSrc.replace(PATCH_FROM, PATCH_TO);

try {
  new Function("module", "exports", "require", runtimeSrc)(
    { exports: {} },
    {},
    () => {
      throw new Error("require not available (chat runtime)");
    },
  );
} catch (e) {
  console.log("[fidelius] runtime threw at top-level (often harmless):", String(e).slice(0, 200));
}

const w = globalThis as unknown as {
  __snapcap_p?: { (id: string): unknown; m: Record<string, Function> };
};
if (!w.__snapcap_p) {
  throw new Error("__snapcap_p not exposed — runtime patch may have failed");
}
const wreq = w.__snapcap_p;
console.log(`[fidelius] runtime ready, modules registered so far: ${Object.keys(wreq.m).length}`);

// Load the messaging-init chunk along with main so its modules
// (createMessagingSession, etc.) register and we can invoke them.
const F16F_PATH = join(CHAT_DW, "f16f14e3b729db223348.chunk.js");
console.log("[fidelius] loading chat-bundle main (9846a…)…");
let mainSrc = readFileSync(MAIN_PATH, "utf8");

// Snap's webpack build stubs out Node-only modules (`fs`, `path`, `buffer`)
// because the browser code path uses fetch + crypto.subtle. We're in Node,
// so where the bundle hits a stub during top-level eval we need real impls.
// Replace the empty bodies with assignments to a global shim table that
// installShims has already populated.
const fsSync = await import("node:fs");
(globalThis as unknown as { __snapcap_node_buffer: { Buffer: typeof Buffer } }).__snapcap_node_buffer = { Buffer };
(globalThis as unknown as { __snapcap_node_fs: typeof fsSync }).__snapcap_node_fs = fsSync;

const STUB_PATCHES: Array<[string, string]> = [
  // Buffer polyfill — sha256 needs `n(91903).Buffer` to be the real Buffer.
  ["91903(){}", "91903(e,t){t.Buffer=globalThis.__snapcap_node_buffer.Buffer}"],
  // fs — Emscripten's Node detection branch needs a working fs.
  ["36675(){}", "36675(e,t){Object.assign(t,globalThis.__snapcap_node_fs)}"],
];
let patched = 0;
for (const [from, to] of STUB_PATCHES) {
  if (mainSrc.includes(from)) {
    mainSrc = mainSrc.replace(from, to);
    patched++;
  } else {
    console.log(`[fidelius] WARN: patch site missing: ${from}`);
  }
}
console.log(`[fidelius] applied ${patched}/${STUB_PATCHES.length} node-stub patches to main`);

try {
  new Function("module", "exports", "require", mainSrc)(
    { exports: {} },
    {},
    () => {
      throw new Error("require not available (chat main)");
    },
  );
} catch (e) {
  console.log("[fidelius] main threw at top-level:", String(e).slice(0, 200));
}
console.log(`[fidelius] modules after main: ${Object.keys(wreq.m).length}`);

if (!wreq.m["86818"]) {
  throw new Error("module 86818 (Emscripten factory) not registered");
}

console.log("[fidelius] resolving module 86818 (Emscripten Module factory)…");
const factoryMod = wreq("86818") as { A?: Function; default?: Function } & Record<string, unknown>;
const factory = (factoryMod.A ?? factoryMod.default ?? factoryMod) as Function;
if (typeof factory !== "function") {
  console.log("[fidelius] 86818 module shape:", Object.keys(factoryMod));
  throw new Error("module 86818 did not yield a callable factory");
}

console.log("[fidelius] reading wasm bytes…");
const wasmBytes = readFileSync(WASM_PATH);
console.log(`[fidelius] wasm: ${wasmBytes.byteLength} bytes`);

console.log("[fidelius] booting Module…");
// Hook _emval_* to log every JS-side EmVal handle interaction. Lets us
// see which arg the WASM is dereferencing when constructPostLogin fails.
let emvalTrace = false;
function wrapEmvalImports(imports: WebAssembly.Imports) {
  const env = imports.env as Record<string, Function>;
  const decodeCStr = (ptr: number): string => {
    // Resolve memory live each call — Emscripten heap may be reset/grown.
    const heap = (Module as { HEAPU8?: Uint8Array }).HEAPU8;
    if (!heap) return `<${ptr}>`;
    let end = ptr;
    while (end < heap.length && heap[end] !== 0) end++;
    return new TextDecoder().decode(heap.subarray(ptr, end));
  };
  // Trace ALL emval-named imports
  const emvalNames = Object.keys(env).filter((n) => n.startsWith("_emval_"));
  for (const name of emvalNames) {
    const orig = env[name];
    if (typeof orig !== "function") continue;
    env[name] = function (...args: unknown[]) {
      try {
        const r = orig.apply(this, args);
        if (emvalTrace) {
          let extra = "";
          // Decode cstrings for any function that takes a c-string ptr first arg
          if (typeof args[0] === "number" && (name === "_emval_new_cstring" || name === "_emval_get_global" || name === "_emval_get_module_property")) {
            extra = ` "${decodeCStr(args[0])}"`;
          }
          process.stderr.write(`  [emval] ${name}(${args.join(",")})${extra} → ${r}\n`);
        }
        return r;
      } catch (e) {
        if (emvalTrace) process.stderr.write(`  [emval ERR] ${name}(${args.join(",")}) → ${(e as Error).message.slice(0, 100)}\n`);
        throw e;
      }
    };
  }
}
let runtimeInitDone = false;
const moduleEnv: Record<string, unknown> = {
  preRun: () => process.stderr.write("[fidelius] preRun fired\n"),
  postRun: () => process.stderr.write("[fidelius] postRun fired\n"),
  onRuntimeInitialized: () => {
    process.stderr.write("[fidelius] onRuntimeInitialized fired\n");
    runtimeInitDone = true;
  },
  instantiateWasm: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, mod?: WebAssembly.Module) => void,
  ): unknown => {
    process.stderr.write(
      `[fidelius] instantiateWasm called — imports.env has ${Object.keys(imports.env ?? {}).length} entries\n`,
    );
    wrapEmvalImports(imports);

    const env = imports.env as Record<string, Function>;

    // Hook __cxa_throw — when C++ throws, this is called with the
    // exception payload. Lets us catch the real source of failure
    // (the OOB might just be exception unwinding).
    const cxaThrow = env.__cxa_throw;
    if (typeof cxaThrow === "function") {
      env.__cxa_throw = function (...args: unknown[]) {
        process.stderr.write(`[__cxa_throw] args=[${args.join(",")}] — C++ exception thrown!\n`);
        return cxaThrow.apply(this, args);
      };
    }

    // Hook EVERY invoke_* import — when WASM does call_indirect via JS,
    // it goes through one of these.
    const invokeNames = Object.keys(env).filter((k) => k.startsWith("invoke_"));
    process.stderr.write(`[fidelius] hooking ${invokeNames.length} invoke_* imports\n`);
    let invokeCount = 0;
    let recentInvokes: string[] = [];
    let invokeFirstFail = false;
    for (const name of invokeNames) {
      const orig = env[name];
      if (typeof orig !== "function") continue;
      env[name] = function (...args: unknown[]) {
        const idx = args[0];
        invokeCount++;
        const summary = `${name}(idx=${idx},${args.slice(1).join(",")})`;
        recentInvokes.push(summary);
        if (recentInvokes.length > 20) recentInvokes.shift();
        try {
          return orig.apply(this, args);
        } catch (e) {
          if (!invokeFirstFail) {
            invokeFirstFail = true;
            process.stderr.write(`\n[invoke FAIL] total invokes before fail: ${invokeCount}\n`);
            process.stderr.write(`[invoke FAIL] last 20 invokes (oldest→newest):\n`);
            for (const r of recentInvokes) process.stderr.write(`    ${r}\n`);
          }
          throw e;
        }
      };
    }
    WebAssembly.instantiate(wasmBytes, imports).then(
      (res) => {
        process.stderr.write(`[fidelius] WASM compiled OK — calling successCallback\n`);
        successCallback(res.instance, res.module);
        process.stderr.write(`[fidelius] successCallback returned\n`);
      },
      (err) => {
        process.stderr.write(`[fidelius] WebAssembly.instantiate REJECTED: ${err.message}\n`);
      },
    );
    return {};
  },
  onAbort: (reason: unknown) => {
    process.stderr.write(`[fidelius] Module ABORTED: ${String(reason)}\n`);
    throw new Error(`e4fa Module aborted: ${String(reason)}`);
  },
  print: (...args: unknown[]) => process.stderr.write(`[wasm:out] ${args.join(" ")}\n`),
  printErr: (...args: unknown[]) => process.stderr.write(`[wasm:err] ${args.join(" ")}\n`),
  locateFile: (name: string) => {
    process.stderr.write(`[fidelius] locateFile("${name}")\n`);
    return name;
  },
};

// factory returns moduleEnv.ready — a Promise that resolves to the
// populated Module (= moduleEnv) once Wasm + embind init complete.
process.stderr.write("[fidelius] calling factory...\n");
let factoryResult: unknown;
try {
  factoryResult = factory(moduleEnv);
} catch (e) {
  const err = e as Error;
  process.stderr.write(`[fidelius] factory threw synchronously: ${err.message}\n${err.stack}\n`);
  process.exit(1);
}
process.stderr.write(
  `[fidelius] factory returned. type=${typeof factoryResult} hasThen=${typeof (factoryResult as { then?: Function })?.then === "function"}\n`,
);
process.stderr.write(
  `[fidelius] moduleEnv keys after factory call: ${Object.keys(moduleEnv).join(", ").slice(0, 200)}\n`,
);

// Periodic progress so we can see where it hangs. Use unref so the timer
// doesn't keep the process alive on its own.
const ticker = setInterval(() => {
  const e = moduleEnv as Record<string, unknown>;
  const newKeys = Object.keys(e).filter((k) =>
    /fidelius|kraken|encrypt|decrypt|messaging|crypto/i.test(k),
  );
  process.stderr.write(
    `[fidelius] tick — calledRun=${e.calledRun ?? "?"} keys=${Object.keys(e).length} fidelius?=${newKeys.length}\n`,
  );
}, 1000);
ticker.unref?.();

// Module.ready never resolves cleanly even though preRun + onRuntimeInitialized
// + postRun all fire — the bundle's resolver hook seems to be wired through a
// path our shimmed environment doesn't trigger. Instead of awaiting the Promise,
// poll runtimeInitDone (set in our onRuntimeInitialized callback). At that point
// Embind has finished registering classes on moduleEnv.
const READY_TIMEOUT_MS = 20_000;
const startedAt = Date.now();
while (!runtimeInitDone) {
  if (Date.now() - startedAt > READY_TIMEOUT_MS) {
    clearInterval(ticker);
    process.stderr.write("[fidelius] timeout waiting for runtime init\n");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 50));
}
clearInterval(ticker);
process.stderr.write(`[fidelius] runtime initialized in ${Date.now() - startedAt}ms — using moduleEnv directly\n`);
const Module = moduleEnv as Record<string, unknown>;

process.stderr.write("[fidelius] inspecting Module exports…\n");
let exportNames: string[];
try {
  exportNames = Object.keys(Module).sort();
} catch (e) {
  process.stderr.write(`[fidelius] Object.keys threw: ${(e as Error).message}\n`);
  process.exit(1);
}
process.stderr.write(`[fidelius] Module has ${exportNames.length} top-level keys\n`);

// Highlight Fidelius / messaging / Embind class names
const interesting = exportNames.filter((k) =>
  /fidelius|kraken|encrypt|decrypt|messaging|crypto|platform|config_/i.test(k),
);
process.stderr.write(`[fidelius] interesting exports (${interesting.length}):\n`);
for (const k of interesting) process.stderr.write(`  ${k}\n`);

// Probe key Embind classes for static methods + instance method signatures.
function probeClass(name: string): void {
  const klass = (Module as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
  process.stderr.write(`\n=== ${name} ===\n`);
  if (!klass) {
    process.stderr.write("  (not present)\n");
    return;
  }
  process.stderr.write(`  type: ${typeof klass}\n`);
  // Static methods/properties
  const staticKeys = Object.getOwnPropertyNames(klass).filter((k) => !k.startsWith("__"));
  process.stderr.write(`  static keys: ${staticKeys.join(", ") || "(none)"}\n`);
  // Prototype methods
  const proto = (klass as { prototype?: unknown }).prototype;
  if (proto) {
    const protoKeys = Object.getOwnPropertyNames(proto).filter(
      (k) => !k.startsWith("__") && k !== "constructor",
    );
    process.stderr.write(`  prototype methods: ${protoKeys.join(", ") || "(none)"}\n`);
  }
}

for (const name of [
  "e2ee_E2EEKeyManager",
  "e2ee_KeyProvider",
  "e2ee_KeyPersistentStorageDelegate",
  "e2ee_GetKeyForCurrentUserCallback",
  "e2ee_BlizzardEventDelegate",
]) {
  probeClass(name);
}

// Probe E2EEKeyManager static method arg counts
process.stderr.write("\n=== e2ee_E2EEKeyManager static arg counts ===\n");
const km = Module.e2ee_E2EEKeyManager as Record<string, unknown>;
for (const m of [
  "constructPostLogin",
  "constructWithKey",
  "createSharedSecretKeys",
  "generateKeyInitializationRequest",
]) {
  const fn = km[m] as { argCount?: number; length?: number } | undefined;
  process.stderr.write(`  ${m}: argCount=${fn?.argCount}, length=${fn?.length}\n`);
}


// createSharedSecretKeys(2 args) — likely (privateKey, publicKey) returning shared secret
process.stderr.write("\n--- createSharedSecretKeys(2 args) ---\n");
const cssFn = km.createSharedSecretKeys as (...a: unknown[]) => unknown;
for (const [a, b] of [
  [new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0x02)],
  ["a", "b"],
]) {
  try {
    const r = cssFn(a, b);
    process.stderr.write(`  args=(${typeof a}, ${typeof b}) → ${typeof r}; ${r instanceof Uint8Array ? `Uint8Array(${r.byteLength})` : JSON.stringify(r)?.slice(0, 200)}\n`);
  } catch (e) {
    process.stderr.write(`  args=(${typeof a}, ${typeof b}) threw: ${(e as Error).message.slice(0, 200)}\n`);
  }
}

// Show all top-level Module keys (not just our filter) — free functions
// for creation likely show up here.
process.stderr.write("\n=== ALL Module keys ===\n");
const allKeys = Object.keys(Module).sort();
const nonClass = allKeys.filter((k) => typeof (Module as Record<string, unknown>)[k] !== "function" || !((Module as Record<string, unknown>)[k] as { prototype?: unknown }).prototype);
process.stderr.write(`free functions / values (${nonClass.length}):\n`);
for (const k of nonClass) {
  const v = (Module as Record<string, unknown>)[k];
  process.stderr.write(`  ${k}: ${typeof v}${typeof v === "function" ? ` (argCount=${(v as { argCount?: number }).argCount})` : ""}\n`);
}
const classes = allKeys.filter((k) => !nonClass.includes(k));
process.stderr.write(`\nEmbind classes (${classes.length}): ${classes.join(", ")}\n`);

// Sweep classes for encrypt/decrypt-ish methods
process.stderr.write("\n=== sweep: encrypt/decrypt-ish methods ===\n");
const ENCRYPT_RE = /encrypt|decrypt|seal|open|wrap|unwrap|cipher|extract|consume/i;
for (const name of classes) {
  const klass = (Module as Record<string, unknown>)[name] as
    | { prototype?: Record<string, unknown> }
    | undefined;
  if (typeof klass !== "function") continue;
  const methods: string[] = [];
  for (const k of Object.getOwnPropertyNames(klass)) {
    if (ENCRYPT_RE.test(k) && !["constructor", "name", "length", "prototype", "argCount"].includes(k))
      methods.push(`static ${k}`);
  }
  if (klass.prototype) {
    for (const k of Object.getOwnPropertyNames(klass.prototype)) {
      if (ENCRYPT_RE.test(k) && k !== "constructor") methods.push(k);
    }
  }
  if (methods.length) {
    process.stderr.write(`  ${name}: ${methods.join(", ")}\n`);
  }
}

// Probe StatelessSession argCount + show methods' arity
const SS = Module.messaging_StatelessSession as Record<string, unknown> & { argCount?: number };
process.stderr.write(`\n=== StatelessSession constructor argCount: ${SS.argCount}\n`);
const proto = (SS as { prototype?: Record<string, unknown> }).prototype;
if (proto) {
  for (const m of ["sendMessageWithContent", "extractMessage", "consumeMessagingPayloadOrSyncConversation", "getConversationMetadata"]) {
    const fn = proto[m] as { argCount?: number; length?: number } | undefined;
    process.stderr.write(`  ${m}: argCount=${fn?.argCount}, length=${fn?.length}\n`);
  }
}

// Try to construct one with no args, see what the error says (it'll list expected args)
process.stderr.write("\n--- attempting `new messaging_StatelessSession()` ---\n");
try {
  const inst = new (SS as new (...args: unknown[]) => unknown)();
  process.stderr.write(`  succeeded! inst keys: ${Object.keys(inst as object).join(", ")}\n`);
} catch (e) {
  process.stderr.write(`  threw: ${(e as Error).message}\n`);
}

// Look for enum-like Module values (Embind registers enums as classes
// with integer-named static keys)
process.stderr.write("\n=== sweep for Embind enums ===\n");
for (const name of allKeys) {
  const klass = (Module as Record<string, unknown>)[name];
  if (typeof klass !== "function") continue;
  const ownProps = Object.getOwnPropertyNames(klass);
  const symbolicProps = ownProps.filter((k) => /^[A-Z][A-Z_0-9]+$/.test(k));
  if (symbolicProps.length > 0) {
    process.stderr.write(`  ${name}: ${symbolicProps.slice(0, 8).join(", ")}${symbolicProps.length > 8 ? "..." : ""}\n`);
  }
}

// ── Install JS-side proxy dispatch helpers ────────────────────────────
// The 06c chunk's Emscripten setup adds these to Module. Without them,
// Djinni JS-proxy method calls fall through and the WASM crashes invoking
// a virtual function pointer that should have been routed via JS.
process.stderr.write("\n=== installing proxy helpers on Module ===\n");
const M = Module as Record<string, unknown>;
const prevCallJs = M.callJsProxyMethod;
M.callJsProxyMethod = function (obj: Record<string, Function>, methodName: string, ...args: unknown[]) {
  process.stderr.write(`  [callJsProxyMethod] ${methodName}(${args.length} args)\n`);
  try {
    return obj[methodName].apply(obj, args);
  } catch (e) {
    return e;
  }
};
process.stderr.write(`  callJsProxyMethod replaced (was ${typeof prevCallJs})\n`);
// Same with makeNativeProviderCallback if it isn't behaving correctly
const prevMakeCb = M.makeNativeProviderCallback;
const finalReg = (M.nativeProviderCallbackFinalizerRegistry ?? new FinalizationRegistry(() => {})) as FinalizationRegistry<unknown>;
M.makeNativeProviderCallback = function (e: unknown) {
  process.stderr.write(`  [makeNativeProviderCallback] called\n`);
  const t = () => (M._callNativeProviderCallback as (x: unknown) => unknown)?.(e);
  try { finalReg.register(t, e as object); } catch {}
  return t;
};
process.stderr.write(`  makeNativeProviderCallback replaced (was ${typeof prevMakeCb})\n`);

// ── Replicate bundle's WASM init sequence ──────────────────────────────
// Bundle calls these on `s` (the Module) right after instantiate:
//   s.shims_Platform.init({assertionMode, minLogLevel}, {logTimedEvent, log})
//   s.shims_Platform.registerSerialTaskQueue(...)
//   s.shims_Platform.installErrorReporter({reportError})
//   s.shims_Platform.installNonFatalReporter({reportError})
//   s.config_ConfigurationRegistry.setCircumstanceEngine(...)
//   s.config_ConfigurationRegistry.setCompositeConfig(...)
//   s.config_ConfigurationRegistry.setExperiments(...)
//   s.config_ConfigurationRegistry.setServerConfig(...)
//   s.config_ConfigurationRegistry.setTweaks(...)
//   s.config_ConfigurationRegistry.setUserPrefs(...)
process.stderr.write("\n=== running bundle's init sequence ===\n");
const Platform = Module.shims_Platform as Record<string, (...a: unknown[]) => unknown>;
const ConfigReg = Module.config_ConfigurationRegistry as Record<string, (...a: unknown[]) => unknown>;

try {
  // assertionMode=2 (ALWAYS), minLogLevel=2 (INFO) — guesses based on enum order
  Platform.init(
    { assertionMode: 2, minLogLevel: 2 },
    {
      logTimedEvent: () => {},
      log: (level: number, tag: unknown, msg: unknown) => {
        process.stderr.write(`  [wasm log lvl=${level} tag=${String(tag).slice(0,40)}] ${String(msg).slice(0,120)}\n`);
      },
    },
  );
  process.stderr.write(`  Platform.init OK\n`);
} catch (e) {
  process.stderr.write(`  Platform.init threw: ${(e as Error).message.slice(0, 200)}\n`);
}

try {
  Platform.installErrorReporter({ reportError: (e: unknown) => {
    process.stderr.write(`  [errorReporter] ${JSON.stringify(e).slice(0, 200)}\n`);
  } });
  process.stderr.write(`  installErrorReporter OK\n`);
} catch (e) {
  process.stderr.write(`  installErrorReporter threw: ${(e as Error).message.slice(0, 200)}\n`);
}

try {
  Platform.installNonFatalReporter({ reportError: (e: unknown) => {
    process.stderr.write(`  [nonFatal] ${JSON.stringify(e).slice(0, 200)}\n`);
  } });
  process.stderr.write(`  installNonFatalReporter OK\n`);
} catch (e) {
  process.stderr.write(`  installNonFatalReporter threw: ${(e as Error).message.slice(0, 200)}\n`);
}

// Empty configs
for (const setter of ["setCircumstanceEngine", "setCompositeConfig", "setExperiments", "setServerConfig", "setTweaks", "setUserPrefs"]) {
  try {
    ConfigReg[setter](new Uint8Array(0));
    process.stderr.write(`  ${setter}(empty) OK\n`);
  } catch (e) {
    process.stderr.write(`  ${setter} threw: ${(e as Error).message.slice(0, 100)}\n`);
  }
}

// gRPC manager — bundle calls registerWebFactory({createClient}). If we
// don't, KeyManager construction may silently bail because it can't
// reach the server.
const GrpcManager = Module.grpc_GrpcManager as Record<string, (...a: unknown[]) => unknown>;
try {
  // The factory itself is a Djinni-bridged interface. Inside it,
  // createClient must return a grpc_UnifiedGrpcService — but the WASM
  // accepts a plain JS object that satisfies the interface (Djinni auto-
  // proxies it). The OOB crash on Oe(idx)(t,n) suggests the C++ side is
  // looking up our method via a function-table index that wasn't registered.
  //
  // Theory: our client method NAMES need to match exactly + the object
  // has to have ONLY those methods (no extras the WASM iterates and
  // chokes on). Let's match the bundle's shape exactly.
  // Keep strong refs so the FinalizationRegistry doesn't reap them
  const grpcClients: unknown[] = [];
  (globalThis as unknown as { __grpcClients: unknown[] }).__grpcClients = grpcClients;

  // Wrap the JS gRPC client in DjinniCppProxy so the WASM sees
  // _djinni_native_ref and routes through trusted trampolines instead
  // of treating the return as an unwrapped JS proxy (which would fail
  // vtable dispatch with OOB on call_indirect).
  const D = Module.DjinniCppProxy as new (impl: unknown, methodSpecs: unknown[]) => unknown;

  const grpcClientFactory = {
    createClient: (config: unknown) => {
      process.stderr.write(`  [grpc.createClient] config: ${JSON.stringify(config).slice(0, 200)}\n`);
      const impl = {
        unaryCall(methodPath: string, body: Uint8Array, options: unknown, callback: unknown) {
          process.stderr.write(`  [grpc.unaryCall] method=${methodPath} body=${body?.byteLength ?? "?"}B\n`);
        },
        serverStreamingCall() { throw new Error("unsupported"); },
        bidiStreamingCall() { throw new Error("unsupported"); },
      };
      grpcClients.push(impl);
      // Try plain object — bundle returns this shape and works in production
      // BUT add a fake $$ to satisfy Embind's class-instance type converter.
      // The converter checks t.$$ exists and t.$$.ptr is non-zero; if both true
      // it tries to "upcast" to the registered class. Provide a non-null ptr
      // and a registeredClass that matches grpc_UnifiedGrpcService.
      try {
        const G = Module.grpc_UnifiedGrpcService as { prototype?: { constructor?: { name: string } } };
        // Some Embind classes expose the registeredClass via the prototype.
        // Heuristic: try to mimic the shape of a real instance.
        Object.defineProperty(impl, "$$", {
          value: {
            ptr: 1,  // non-zero so "Cannot pass deleted" check passes
            ptrType: { registeredClass: G, isConst: false, isSmartPointer: false, baseClass: null, upcast: null },
            count: { value: 1 },
          },
          enumerable: false,
        });
        process.stderr.write(`  [grpc] attached fake $$ to client\n`);
      } catch (e) {
        process.stderr.write(`  [grpc] couldn't attach $$: ${(e as Error).message.slice(0,150)}\n`);
      }
      grpcClients.push(impl);
      return impl;
    },
  };
  (globalThis as unknown as { __grpcFactory: unknown }).__grpcFactory = grpcClientFactory;
  GrpcManager.registerWebFactory(grpcClientFactory);
  process.stderr.write(`  GrpcManager.registerWebFactory OK\n`);
} catch (e) {
  process.stderr.write(`  GrpcManager.registerWebFactory threw: ${(e as Error).message.slice(0, 200)}\n`);
}

// ── Try to construct E2EEKeyManager ────────────────────────────────────
// Bundle pattern (f16f chunk) confirmed:
//   constructPostLogin(grpcCfg, persistentStorageDelegate, sessionScopedStorageDelegate,
//                       userId, upgradeMode, version)
// The two delegates are plain JS objects with the methods Embind expects.
process.stderr.write("\n--- attempting constructPostLogin ---\n");

// Probe gRPC interfaces specifically — methods our client/factory must expose
process.stderr.write("\n=== gRPC interfaces ===\n");
for (const n of ["grpc_UnifiedGrpcService", "grpc_GrpcWebFactory"]) {
  probeClass(n);
}

// Probe Djinni / Cpp proxy classes — Snap uses Djinni-style bindings,
// JS-implemented interfaces likely need wrapping via DjinniCppProxy.
process.stderr.write("\n=== Djinni proxy classes ===\n");
for (const n of ["DjinniCppProxy", "DjinniJsPromiseBuilder", "callJsProxyMethod", "callNativeProviderCallback", "makeNativeProviderCallback", "initCppResolveHandler"]) {
  const v = (Module as Record<string, unknown>)[n];
  process.stderr.write(`  ${n}: ${typeof v}${typeof v === "function" ? ` argCount=${(v as { argCount?: number }).argCount}` : ""}\n`);
  if (typeof v === "function" && (v as { prototype?: object }).prototype) {
    const p = (v as { prototype: object }).prototype;
    const methods = Object.getOwnPropertyNames(p).filter((k) => k !== "constructor");
    if (methods.length) process.stderr.write(`    proto: ${methods.join(", ")}\n`);
  }
}

// In-memory shared store. Will prefill with a freshly minted temp key.
let storedIdentity: unknown = undefined;
let storedRwk: unknown = undefined;
let storedTempKey: unknown = undefined;

// Mint a fresh identity using the WASM's own key generator.
// Arg 0 → version 9 (NINE), wraps under proto field 1.
// Arg 1 → version 10 (TEN), wraps under proto field 2 — matches what
// browsers send to InitializeWebKey at first login.
const minted = (km.generateKeyInitializationRequest as (a: number) => unknown)(1) as {
  keyInfo?: { identity?: unknown; rwk?: unknown };
  request?: unknown;
};
process.stderr.write(`\n=== minted identity ===\n`);
process.stderr.write(`  keyInfo: ${minted.keyInfo ? "yes" : "no"}, identity: ${minted.keyInfo?.identity ? "yes" : "no"}, rwk: ${minted.keyInfo?.rwk ? "yes" : "no"}\n`);

// Prime BOTH the RWK and the identity from minted output.
// generateKeyInitializationRequest returns {keyInfo: {identity, rwk}, request}.
// loadTemporaryIdentityKey usually returns a wrapper of `identity`.
// readRootWrappingKey usually returns the raw rwk bytes.
storedTempKey = minted.keyInfo?.identity;
storedRwk = minted.keyInfo?.rwk;
storedIdentity = minted.keyInfo?.identity; // also try via persistent storage
process.stderr.write(`  primed: tempKey=${!!storedTempKey} rwk=${!!storedRwk} stored=${!!storedIdentity}\n`);

// Class-instance form — some Embind/Djinni bindings probe with `in`
// against own props that arrow-fn objects expose, but proto methods on
// class instances may pass differently.
class PersistentStorage {
  storeUserWrappedIdentityKeys(e: unknown) {
    process.stderr.write(`  persistent.store called (${typeof e})\n`);
    storedIdentity = e;
  }
  loadUserWrappedIdentityKeys() {
    process.stderr.write(`  persistent.load called → ${storedIdentity ? "have key" : "null"}\n`);
    return Promise.resolve(storedIdentity);
  }
}

class SessionScopedStorage {
  storeRootWrappingKey(e: unknown) {
    process.stderr.write(`  session.storeRwk called\n`);
    storedRwk = e;
  }
  readRootWrappingKey() {
    process.stderr.write(`  session.readRwk called → ${storedRwk ? "have" : "null"}\n`);
    return Promise.resolve(storedRwk);
  }
  destroy() {
    storedRwk = undefined;
    return Promise.resolve();
  }
  loadTemporaryIdentityKey() {
    return Promise.resolve(storedTempKey);
  }
  clearTemporaryIdentityKey() {
    storedTempKey = undefined;
    return Promise.resolve();
  }
}

const persistentStorage = new PersistentStorage();
const sessionScopedStorage = new SessionScopedStorage();

// Enable emval tracing only around the failing call.
emvalTrace = true;
// UPGRADE_TO_TEN=1, TEN=1 from JS enum scan.
// 4th arg is the messaging config object — bundle builds it as
// {databaseLocation, userId: {id: "uuid"}, userAgentPrefix, debug, tweaks}.
try {
  const grpcCfg = { apiGatewayEndpoint: "https://us-east1-aws.api.snapchat.com", grpcPathPrefix: "" };
  const sessionCfg = {
    databaseLocation: ":memory:",
    userId: { id: "527be2ff-aaec-4622-9c68-79d200b8bdc1" },
    userAgentPrefix: "",
    debug: false,
    tweaks: { tweaks: new Map() },
  };
  const result = (km.constructPostLogin as (...a: unknown[]) => unknown).call(
    km,
    grpcCfg,
    persistentStorage,
    sessionScopedStorage,
    sessionCfg,
    1, // UPGRADE_TO_TEN
    1, // TEN
  );
  process.stderr.write(`  → SUCCESS! type=${typeof result} value=${String(result).slice(0, 100)}\n`);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    process.stderr.write(`  keys: ${Object.keys(r).join(", ")}\n`);
    // Try to call a method on it
    const km2 = result as { getCurrentUserKeyAsync?: () => Promise<unknown> };
    if (typeof km2.getCurrentUserKeyAsync === "function") {
      process.stderr.write(`  calling getCurrentUserKeyAsync...\n`);
      try {
        const k = await km2.getCurrentUserKeyAsync();
        process.stderr.write(`  → ${typeof k} ${k ? Object.keys(k as object).join(",") : "null"}\n`);
      } catch (e) {
        process.stderr.write(`  threw: ${(e as Error).message.slice(0, 200)}\n`);
      }
    }
  }
  // If undefined, try constructWithKey instead — pass our minted keyInfo
  if (result === undefined) {
    process.stderr.write(`  postLogin returned undefined — trying constructWithKey with minted key\n`);
    const minted2 = (km.generateKeyInitializationRequest as (a: number) => unknown)(1) as {
      keyInfo?: unknown;
    };
    try {
      const result2 = (km.constructWithKey as (...a: unknown[]) => unknown).call(
        km,
        grpcCfg,
        persistentStorage,
        sessionScopedStorage,
        sessionCfg,
        minted2.keyInfo,
        1,
        1,
      );
      process.stderr.write(`  withKey → type=${typeof result2}\n`);
      if (result2 && typeof result2 === "object") {
        const r = result2 as Record<string, unknown>;
        process.stderr.write(`  withKey keys: ${Object.keys(r).join(", ")}\n`);
      }
    } catch (e) {
      process.stderr.write(`  withKey threw: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
} catch (e) {
  const err = e as Error;
  process.stderr.write(`  threw: ${err.message.slice(0, 300)}\n`);
  if (err.stack) process.stderr.write(`  stack: ${err.stack.split("\n").slice(0, 5).join(" | ").slice(0, 500)}\n`);
}
emvalTrace = false;

// ── Register the WASM-minted identity via the SDK Fidelius API ────────
process.stderr.write("\n=== registering identity via SDK ===\n");
const id = (minted.keyInfo as { identity?: { cleartextPublicKey?: object; cleartextPrivateKey?: object; identityKeyId?: { data?: object }; version?: number } }).identity;
const rwk = (minted.keyInfo as { rwk?: { data?: object } }).rwk;
const toBytes = (x: unknown): Uint8Array => {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  if (x && typeof x === "object") return new Uint8Array(Object.values(x as Record<string, number>));
  throw new Error("not bytes");
};
const fideliusIdentity = {
  cleartextPublicKey: toBytes(id?.cleartextPublicKey),
  cleartextPrivateKey: toBytes(id?.cleartextPrivateKey),
  identityKeyId: toBytes(id?.identityKeyId?.data),
  rwk: toBytes(rwk?.data),
  version: id?.version ?? 10,
};
process.stderr.write(`  identity: pub=${fideliusIdentity.cleartextPublicKey.byteLength}B priv=${fideliusIdentity.cleartextPrivateKey.byteLength}B id=${fideliusIdentity.identityKeyId.byteLength}B rwk=${fideliusIdentity.rwk.byteLength}B v=${fideliusIdentity.version}\n`);

try {
  const { readFileSync: r2 } = await import("node:fs");
  const blob = JSON.parse(r2("/tmp/snapcap-smoke-auth.json", "utf8"));
  const { SnapcapClient } = await import("../src/index.ts");
  const client = await SnapcapClient.fromAuth({ auth: blob });
  process.stderr.write(`  using auth for ${client.self?.username}\n`);

  const { initializeWebKey, stripOriginReferer } = await import("../src/api/fidelius.ts");
  const fideliusRpc = client.makeRpc(stripOriginReferer);
  const resp = await initializeWebKey(fideliusRpc, fideliusIdentity);
  process.stderr.write(`  ✅ registered: identityKeyId=${resp.identityKeyId.byteLength}B rwk=${resp.rwk.byteLength}B\n`);
  process.stderr.write(`     id hex: ${Buffer.from(resp.identityKeyId).toString("hex").slice(0, 64)}\n`);
} catch (e) {
  process.stderr.write(`  ❌ ${(e as Error).message.slice(0, 300)}\n`);
}

process.stderr.write("\n[fidelius] DONE\n");
process.exit(0);
