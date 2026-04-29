/**
 * Try to instantiate kameleon.wasm in Node.
 *
 * Plan:
 *   1. Install runtime shims (happy-dom + chrome stub).
 *   2. Install webpack capture so we collect every accounts-bundle module.
 *   3. Load the accounts bundle in canonical Next.js order so its webpack
 *      runtime registers correctly (runtime → polyfills → main → numbered
 *      chunks → _app).
 *   4. Force-require module 58116 (the kameleon Emscripten Module factory)
 *      via webpack's own `__webpack_require__` (captured as `__snapcap_webpack_p`).
 *   5. Call the factory with an `instantiateWasm` callback that injects our
 *      local kameleon.077113e1.wasm bytes — sidestepping fetch entirely.
 *   6. Inspect the returned Module to discover the Embind-bound API.
 *
 * The module factory returns a Promise of the Module object; that Module is
 * what kameleon's C++ code exposes (Embind classes, free functions, etc.).
 * Logging the keys tells us the public API surface for attestation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../src/shims/runtime.ts";
import { installWebpackCapture } from "../src/shims/webpack-capture.ts";

installShims({ url: "https://accounts.snapchat.com/" });
const cap = installWebpackCapture();

const accountsDir = join(
  import.meta.dir,
  "..",
  "vendor",
  "snap-bundle",
  "static.snapchat.com",
  "accounts",
  "_next",
  "static",
  "chunks",
);

// Order matters for webpack: runtime first, then framework/main/polyfills,
// then numbered chunks, then page bundles.
const FILES_IN_ORDER = [
  "webpack-5c0e3c9fd3281330.js",
  "polyfills-42372ed130431b0a.js",
  "framework-41b02394b273386f.js",
  "main-0ebbe566bb0a52ef.js",
];
// Add every numbered chunk in the chunks dir alphabetically.
for (const f of readdirSync(accountsDir).sort()) {
  if (!f.endsWith(".js")) continue;
  if (FILES_IN_ORDER.includes(f)) continue;
  FILES_IN_ORDER.push(f);
}
// Finally the _app page bundle.
FILES_IN_ORDER.push("pages/_app-7ccf4584432ba8ad.js");

console.log(`[kam] loading ${FILES_IN_ORDER.length} accounts files…`);
for (const rel of FILES_IN_ORDER) {
  const path = join(accountsDir, rel);
  try {
    let src = readFileSync(path, "utf8");
    // Patch the webpack runtime IIFE to leak `p` (the __webpack_require__) to
    // globalThis. The runtime keeps p closure-private, but downstream code
    // calls `chunk[2](p)` for chunks with a runtime entry — by which time
    // webpack has already processed the chunks (so wrapping chunk[2] is too
    // late). Source-patching is simpler and reliable.
    if (rel.startsWith("webpack-")) {
      const before = src.length;
      src = src.replace("p.m=s,p.amdO={}", "globalThis.__snapcap_p=p,p.m=s,p.amdO={}");
      if (src.length === before) {
        console.log(`  ! webpack runtime patch failed — pattern not found`);
      } else {
        console.log(`  + patched webpack runtime to expose p as __snapcap_p`);
      }
    }
    new Function("module", "exports", "require", src)(
      { exports: {} },
      {},
      () => {
        throw new Error(`require not available (${rel})`);
      },
    );
  } catch (e) {
    console.log(`  ! ${rel}: ${(e as Error).message?.slice(0, 120)}`);
  }
}
console.log(`[kam] originals: ${cap.originals.size} factories`);

// Diagnostic: dump chunk array contents.
const w = globalThis as unknown as Record<string, unknown> & {
  __snapcap_webpack_p?: { (id: string): unknown; m: Record<string, Function> };
};
const arr = w.webpackChunk_N_E as unknown[] | undefined;
console.log(`[kam] webpackChunk_N_E length: ${arr?.length}`);
let chunksWithRuntime = 0;
if (Array.isArray(arr)) {
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (!Array.isArray(c)) continue;
    const ids = Array.isArray(c[0]) ? c[0] : [];
    const modKeys = c[1] && typeof c[1] === "object" ? Object.keys(c[1] as object).length : 0;
    const hasRuntime = c.length >= 3 && typeof c[2] === "function";
    if (hasRuntime) chunksWithRuntime++;
    console.log(`  chunk[${i}] ids=[${ids.slice(0, 3)}] mods=${modKeys} runtime=${hasRuntime}`);
  }
}
console.log(`[kam] chunks with runtime function: ${chunksWithRuntime}`);

const wPatched = w as Record<string, unknown> & {
  __snapcap_p?: { (id: string): unknown; m: Record<string, Function> };
};
if (!wPatched.__snapcap_p) {
  console.error("[kam] __snapcap_p not captured — runtime patch didn't take effect");
  process.exit(2);
}
const wreq = wPatched.__snapcap_p;
console.log(`[kam] webpack require captured; modules in p.m: ${Object.keys(wreq.m).length}`);

// Module 58116 = kameleon Emscripten Module factory (e.exports = g, e.exports.default = g).
console.log("[kam] requiring module 58116 (kameleon factory)…");
let kamFactoryMod: { default?: Function } & Record<string, unknown>;
try {
  kamFactoryMod = wreq("58116") as { default?: Function } & Record<string, unknown>;
} catch (e) {
  console.error(`[kam] failed to require 58116: ${(e as Error).message}`);
  process.exit(2);
}
const kamFactory = (kamFactoryMod.default ?? kamFactoryMod) as Function;
console.log(`[kam] factory typeof: ${typeof kamFactory}`);

const wasmPath = join(
  import.meta.dir,
  "..",
  "vendor",
  "snap-bundle",
  "static.snapchat.com",
  "accounts",
  "_next",
  "static",
  "media",
  "kameleon.077113e1.wasm",
);
const wasmBytes = readFileSync(wasmPath);
console.log(`[kam] loaded local wasm: ${wasmBytes.byteLength} bytes`);

// Build Module options. Instrument the Emscripten Embind glue so we can
// see which JS properties / globals kameleon reads. The std::string error
// is caused by a JS prop returning undefined; logging the lookups will
// reveal which one.
let traceProps = false;
const moduleOpts = {
  instantiateWasm: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ): unknown => {
    const env = imports.env as Record<string, Function>;
    let memBuf: ArrayBuffer | null = null;
    const readCStr = (ptr: number): string => {
      if (!memBuf) return `<ptr ${ptr}>`;
      const u8 = new Uint8Array(memBuf);
      let end = ptr;
      while (end < u8.length && u8[end] !== 0) end++;
      return new TextDecoder().decode(u8.subarray(ptr, end));
    };
    // String-arg lookups: log the actual string from heap.
    const stringFns = new Set([
      "_emval_get_global",
      "_emval_get_module_property",
      "_emval_new_cstring",
    ]);
    for (const n of [
      "_emval_get_property",
      "_emval_get_global",
      "_emval_get_module_property",
      "_emval_call_method",
      "_emval_call",
      "_emval_new_cstring",
      "_emval_take_value",
    ]) {
      const orig = env[n];
      if (typeof orig !== "function") continue;
      env[n] = function (...args: unknown[]) {
        const r = orig(...args);
        if (traceProps) {
          let detail = "";
          if (stringFns.has(n) && typeof args[0] === "number" && args[0] !== 0) {
            detail = ` "${readCStr(args[0])}"`;
          }
          console.log(`[trace] ${n}(${args.join(", ")})${detail} → ${r}`);
        }
        return r;
      };
    }

    WebAssembly.instantiate(wasmBytes, imports)
      .then((res) => {
        memBuf = (res.instance.exports.memory as WebAssembly.Memory).buffer;
        console.log(`[kam] WASM instantiated`);
        successCallback(res.instance, res.module);
      })
      .catch((e) => {
        console.error("[kam] instantiate failed:", (e as Error).message?.slice(0, 200));
      });
    return {};
  },
  onAbort: (reason: unknown) => console.error("[kam] aborted:", reason),
  print: (msg: string) => console.log(`[kam.out] ${msg}`),
  printErr: (msg: string) => console.log(`[kam.err] ${msg}`),
  locateFile: (name: string) => name,
  // The wrapper module 59855 (createModule) attaches these AFTER the
  // factory resolves. We set them directly because we're calling the
  // factory ourselves. The C++ side reads `page` as std::string and calls
  // methods on `Graphene` for telemetry — without them, instance() throws.
  page: "www_login",
  version: "4.0.3",
  Graphene: {
    increment: (_metric: { metricsName?: string; dimensions?: object }) => {},
    addTimer: (_t: { metricsName?: string; milliSec?: number }) => {},
  },
  // UAParser and WebAttestationServiceClient are constructed below from
  // their webpack modules and assigned post-instantiation.
  UAParserInstance: undefined as unknown,
  webAttestationServiceClientInstance: undefined as unknown,
};

// Pull the UA parser (module 40243) and gRPC client (module 94631) from the
// loaded accounts bundle so we can give kameleon the full env it expects.
try {
  const uaModule = wreq("40243") as { UAParser: new () => unknown } & { default?: { UAParser?: new () => unknown } };
  const UA = uaModule.UAParser ?? uaModule.default?.UAParser;
  if (UA) {
    moduleOpts.UAParserInstance = new UA();
    console.log(`[kam] UAParser instance constructed`);
  }
} catch (e) {
  console.log(`[kam] UAParser fetch failed: ${(e as Error).message?.slice(0, 100)}`);
}
try {
  const grpcMod = wreq("94631") as { WebAttestationServiceClient?: new (host: string) => unknown };
  if (grpcMod.WebAttestationServiceClient) {
    moduleOpts.webAttestationServiceClientInstance = new grpcMod.WebAttestationServiceClient(
      "https://session.snapchat.com",
    );
    console.log(`[kam] WebAttestationServiceClient constructed`);
  }
} catch (e) {
  console.log(`[kam] WebAttestationServiceClient fetch failed: ${(e as Error).message?.slice(0, 100)}`);
}

console.log("[kam] calling kameleon factory…");
let mod: Record<string, unknown>;
try {
  const result = kamFactory(moduleOpts);
  if (result && typeof (result as { then?: Function }).then === "function") {
    mod = (await (result as Promise<Record<string, unknown>>)) as Record<string, unknown>;
  } else {
    mod = result as Record<string, unknown>;
  }
} catch (e) {
  console.error(`[kam] factory threw: ${(e as Error).message?.slice(0, 400)}`);
  process.exit(2);
}

console.log(`[kam] ✓ Module instantiated`);
const keys = Object.keys(mod);
console.log(`[kam] Module has ${keys.length} top-level keys`);
const interesting = keys.filter((k) =>
  /^[A-Z]/.test(k) && !/^(FS|HEAP|wasm|asm|ccall|cwrap|UTF|Module|ALLOC|ENVIRONMENT|ERRNO)/.test(k),
);
console.log(`[kam] interesting (likely Embind-bound): ${interesting.slice(0, 40).join(", ")}`);

// Print every key with its type for clarity.
console.log(`[kam] full key/type list:`);
for (const k of keys.sort()) {
  const v = mod[k];
  let label = typeof v;
  if (typeof v === "function") {
    const proto = (v as { prototype?: object }).prototype;
    if (proto && Object.keys(proto).length > 0) {
      label = `class(${Object.keys(proto).slice(0, 5).join(",")})`;
    }
  } else if (v && typeof v === "object") {
    label = `obj(${Object.keys(v as object).slice(0, 5).join(",")})`;
  }
  console.log(`    ${k}: ${label}`);
}

// Probe the AttestationSession class.
const AS = mod.AttestationSession as {
  instance: () => Record<string, unknown>;
} & Function;
console.log(`\n[kam] AttestationSession typeof: ${typeof AS}`);
console.log(`[kam] AttestationSession own keys: ${Object.keys(AS).join(", ")}`);
const proto = (AS as { prototype?: object }).prototype;
console.log(`[kam] prototype keys: ${proto ? Object.keys(proto).join(", ") : "(none)"}`);
console.log(`[kam] prototype methods: ${proto ? Object.getOwnPropertyNames(proto).join(", ") : "(none)"}`);

console.log(`\n[kam] AttestationSession.argCount: ${(AS as unknown as { argCount?: number }).argCount}`);
console.log(`[kam] AttestationSession.toString:\n${AS.toString()}\n`);
console.log(`[kam] AttestationSession.instance.toString:\n${(AS.instance as Function).toString()}\n`);
const protoFin = (AS as unknown as { prototype: { finalize: Function } }).prototype.finalize;
console.log(`[kam] prototype.finalize.toString:\n${protoFin.toString()}\n`);

const ident = process.env.SNAP_USER ?? "perdyjamie";

// Enable tracing now that the Module is set up.
traceProps = true;

// Try various invocation patterns. Embind wraps may behave differently
// depending on `this` binding.
const attempts: Array<[string, () => unknown]> = [
  ["AS.instance()", () => (AS.instance as Function)()],
  ["AS.instance.call(AS)", () => (AS.instance as Function).call(AS)],
  ["AS.instance.call(null)", () => (AS.instance as Function).call(null)],
  ["AS.instance.apply(AS, [])", () => (AS.instance as Function).apply(AS, [])],
  ["new AS()", () => new (AS as new () => unknown)()],
  ["new AS('a')", () => new (AS as new (s: string) => unknown)("a")],
  ["new AS(ident)", () => new (AS as new (s: string) => unknown)(ident)],
];
let session: Record<string, unknown> | null = null;
for (const [label, fn] of attempts) {
  try {
    const r = fn();
    console.log(`[kam] ${label} → ${typeof r}`);
    if (r && typeof r === "object") {
      session = r as Record<string, unknown>;
      console.log(`  keys: ${Object.keys(r).join(", ")}`);
      const sp = Object.getPrototypeOf(r);
      console.log(`  proto methods: ${Object.getOwnPropertyNames(sp).join(", ")}`);
      break;
    }
  } catch (e) {
    console.log(`[kam] ${label} ✗ ${(e as Error).message?.slice(0, 150)}`);
  }
}

if (session) {
  console.log(`\n[kam] calling session.finalize("${ident}")…`);
  try {
    const fin = session.finalize as (s: string) => Promise<unknown> | unknown;
    let tok = fin.call(session, ident);
    if (tok && typeof (tok as { then?: Function }).then === "function") {
      tok = await tok;
    }
    if (typeof tok === "string") {
      console.log(`[kam] ✓ finalize → string len=${tok.length}: ${tok.slice(0, 200)}`);
    } else {
      console.log(`[kam] ✓ finalize → ${typeof tok}:`, tok);
    }
  } catch (e) {
    console.error(`[kam] ✗ finalize: ${(e as Error).message?.slice(0, 600)}`);
  }
}

process.exit(0);
