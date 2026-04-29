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

// ── Try to construct E2EEKeyManager ────────────────────────────────────
// Bundle pattern (f16f chunk) confirmed:
//   constructPostLogin(grpcCfg, persistentStorageDelegate, sessionScopedStorageDelegate,
//                       userId, upgradeMode, version)
// The two delegates are plain JS objects with the methods Embind expects.
process.stderr.write("\n--- attempting constructPostLogin ---\n");

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

// First, mint a fresh identity using the WASM's own key generator —
// this tells us what shape the storage delegate is expected to round-trip.
const minted = (km.generateKeyInitializationRequest as (a: number) => unknown)(0) as {
  keyInfo?: unknown;
  rwk?: unknown;
};
process.stderr.write(`\n=== minted identity ===\n`);
process.stderr.write(`  keyInfo: ${minted.keyInfo ? "yes" : "no"}, rwk: ${minted.rwk ? "yes" : "no"}\n`);

// In-memory shared store, prefilled with the freshly minted key.
// Bundle's `loadUserWrappedIdentityKeys` returns a serialized blob (the
// "wrapped" form — encrypted-at-rest with the rwk). For a fresh start
// without a stored blob, returning undefined is the documented signal
// for "no prior key" — but maybe what's really expected is the same
// shape as keyInfo from generateKeyInitializationRequest.
let storedIdentity: unknown = undefined; // start "logged in but no stored key"
let storedRwk: unknown = undefined;
let storedTempKey: unknown = undefined;

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

// UPGRADE_TO_TEN=1, TEN=1 from JS enum scan
try {
  const grpcCfg = { apiGatewayEndpoint: "https://us-east1-aws.api.snapchat.com", grpcPathPrefix: "" };
  const result = (km.constructPostLogin as (...a: unknown[]) => unknown).call(
    km,
    grpcCfg,
    persistentStorage,
    sessionScopedStorage,
    "527be2ff-aaec-4622-9c68-79d200b8bdc1",
    1, // UPGRADE_TO_TEN
    1, // TEN
  );
  process.stderr.write(`  → SUCCESS! type=${typeof result}\n`);
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
} catch (e) {
  const err = e as Error;
  process.stderr.write(`  threw: ${err.message.slice(0, 300)}\n`);
  if (err.stack) process.stderr.write(`  stack: ${err.stack.split("\n").slice(0, 5).join(" | ").slice(0, 500)}\n`);
}

process.stderr.write("\n[fidelius] DONE\n");
process.exit(0);
