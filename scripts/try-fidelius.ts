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

process.stderr.write("[fidelius] DONE — calling process.exit(0)\n");
process.exit(0);
