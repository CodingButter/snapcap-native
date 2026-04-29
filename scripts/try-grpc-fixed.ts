/**
 * Drive Snap's chat-bundle WASM with full instrumentation. Per ChatGPT
 * consult: top suspects are SerialTaskQueue contract, empty config blobs,
 * gRPC heap buffer lifetime, and delegate nullability.
 *
 * This rev:
 *   1. Patch Module.abort + onAbort with stacks
 *   2. process.on unhandledRejection / uncaughtException
 *   3. Promise-chained FIFO SerialTaskQueue with per-task logging
 *   4. Delay-free gRPC heap buffers (debug — never free in this run)
 *   5. Proxy-wrap every delegate to log call/return/throw
 *   6. constructPostLogin → wait → call methods, see what fires
 */
import { readFileSync } from "node:fs";
import { nativeFetch } from "../src/transport/native-fetch.ts";  // bypasses happy-dom CORS
import { mintFideliusIdentity } from "../src/auth/fidelius-mint.ts";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";
import { FileDataStore } from "../src/storage/data-store.ts";

const dataStore = new FileDataStore("/home/codingbutter/snapcap/SnapSDK/.tmp_auth/wasm-state");

const log = (...args: unknown[]): void => {
  const s = args.map((a) => typeof a === "string" ? a : JSON.stringify(a, (_k, v) => v instanceof Uint8Array ? `<${v.byteLength}B>` : v)).join(" ");
  process.stderr.write(s + "\n");
};

// Process-level error catchers per ChatGPT recommendation.
process.on("unhandledRejection", (err) => {
  log(`[unhandledRejection]`, (err as Error)?.stack ?? err);
});
process.on("uncaughtException", (err) => {
  log(`[uncaughtException]`, (err as Error)?.stack ?? err);
});
Error.stackTraceLimit = 100;

const AUTH_PATH = "/home/codingbutter/snapcap/SnapSDK/.tmp_auth/auth.json";
const blob = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius;
if (!fid) throw new Error("no fidelius — log in fresh first");

const client = await SnapcapClient.fromAuth({ auth: blob });
log(`client restored as ${client.self?.username}`);

// Hook WebAssembly.instantiate to wrap imports BEFORE the WASM is built.
// This lets us intercept __assert_fail / __cxa_throw / abort before init.
const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
let capturedImports: Record<string, Record<string, Function>> | null = null;
(WebAssembly as { instantiate: typeof WebAssembly.instantiate }).instantiate = (async (
  buffer: BufferSource,
  imports?: Record<string, Record<string, Function>>,
) => {
  if (imports && (imports.env || imports.a) && Object.keys(imports.env || imports.a).length > 100) {
    capturedImports = imports;
    const env = imports.env || imports.a;
    log(`[wasm.imports] hooking ${Object.keys(env).length} imports`);
    for (const k of Object.keys(env)) {
      const fn = env[k];
      if (typeof fn !== "function") continue;
      const src = fn.toString().slice(0, 200);
      // Hook common abort/assert names
      // Hook emval property/method imports to log lookups before they throw.
      const emvalLookups = ["_emval_get_property", "_emval_call_method", "_emval_call_void_method", "_emval_get_method_caller"];
      if (emvalLookups.includes(k) || (src.includes("emval_handle") && (src.includes(".apply") || src.includes("[")))) {
        const orig = fn;
        env[k] = function(...args: unknown[]) {
          // Most emval-call args: (handle, methodNameCStr, ...) — try to decode methodNameCStr
          let methodName = "?";
          for (const a of args.slice(0, 3)) {
            if (typeof a === "number" && a > 0x10000 && a < 0x10000000) {
              const h = (Module as { HEAPU8?: Uint8Array }).HEAPU8;
              if (h && h[a] >= 0x20 && h[a] <= 0x7e) {
                let end = a;
                while (end < h.byteLength && h[end] !== 0 && end - a < 80) end++;
                const s = new TextDecoder("utf-8", { fatal: false }).decode(h.subarray(a, end));
                if (s.length > 1 && /^[\x20-\x7e]+$/.test(s)) {
                  methodName = s; break;
                }
              }
            }
          }
          try {
            return orig.apply(this, args as []);
          } catch (e) {
            log(`[${k} prop="${methodName}"] threw:`, (e as Error).message?.slice(0, 200));
            throw e;
          }
        };
        continue;
      }
      if (k.match(/assert|abort|cxa_throw/i) || src.includes("assert_fail") || src.includes("cxa_throw") || src.includes("abort()")) {
        const orig = fn;
        const isCxaThrow = k.includes("cxa_throw") || src.includes("cxa_throw");
        env[k] = function patched(...args: unknown[]) {
          const heap = () => (Module as { HEAPU8?: Uint8Array })?.HEAPU8;
          const readCStr = (ptr: number, max = 800) => {
            const h = heap();
            if (!h || ptr < 0x10000 || ptr > 0x10000000) return `<bad ptr 0x${ptr.toString(16)}>`;
            let end = ptr;
            while (end < h.byteLength && h[end] !== 0 && end - ptr < max) end++;
            return new TextDecoder("utf-8", { fatal: false }).decode(h.subarray(ptr, end));
          };
          const readU32 = (ptr: number) => {
            const h = heap();
            if (!h || ptr < 0 || ptr + 4 > h.byteLength) return 0;
            return new DataView(h.buffer, ptr, 4).getUint32(0, true);
          };
          if (isCxaThrow && typeof args[0] === "number" && typeof args[1] === "number") {
            // __cxa_throw(thrown, typeinfo, dtor)
            const tinfo = args[1] as number;
            const namePtr = readU32(tinfo + 4);
            const typeName = readCStr(namePtr);
            const thrown = args[0] as number;
            // Dump first 64 bytes of thrown object for inspection
            const h = heap();
            const dump = h ? Array.from(h.subarray(thrown, thrown + 64)).map(b => b.toString(16).padStart(2,'0')).join('') : '<no heap>';
            // For djinni::JsException — try multiple offsets for what string
            const tries: { off: number; ptr: number; str: string }[] = [];
            for (const off of [0, 4, 8, 12, 16, 20, 24]) {
              const ptr = readU32(thrown + off);
              tries.push({ off, ptr, str: readCStr(ptr) });
            }
            log(`[wasm.${k}] type="${typeName}"`);
            // Find the full readable message — pick longest readable string from tries
            const best = tries.reduce((a, b) => b.str.length > a.str.length ? b : a, { off: -1, ptr: 0, str: "" });
            log(`  msg @ +${best.off}: ${best.str}`);
          } else {
            log(`[wasm.${k}]`, ...args.map((a) => typeof a === "number" ? `0x${a.toString(16)}` : a));
          }
          return orig.apply(this, args as []);
        };
      }
    }
  }
  return origInstantiate(buffer, imports as WebAssembly.Imports);
}) as typeof WebAssembly.instantiate;

process.env.SNAPCAP_EXPOSE_FIDELIUS_MODULE = "1";
await mintFideliusIdentity();

type EmModule = {
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  HEAPU8: Uint8Array;
  abort?: (what?: unknown) => void;
  onAbort?: (what?: unknown) => void;
  [k: string]: unknown;
};
const Module = (globalThis as unknown as { __snapcap_fidelius_module?: EmModule })
  .__snapcap_fidelius_module;
if (!Module) throw new Error("Module not exposed");
log(`Module ready, _malloc=${typeof Module._malloc}, HEAPU8=${Module.HEAPU8?.byteLength}B`);

// Hook globalThis property access — when WASM does Module.SomeClass / globalThis.X
// from the bundle, log misses. Use Reflect.has to catch _emval_get_global lookups.
const _origGetGlobal = (globalThis as { __emval_get_global?: Function }).__emval_get_global;
// Periodically log Module-shaped objects with classes
log(`Module Embind classes: ${Object.keys(Module).filter(k => /^[a-z_]+_[A-Z]/.test(k)).slice(0, 25).join(", ")}…`);

// Patch onAbort only — patching Module.abort directly aborts the
// runtime ('abort' was not exported when we set our own).
Module.onAbort = function onAbortPatched(what?: unknown) {
  log(`[Module.onAbort]`, what);
  log(new Error("onAbort stack").stack ?? "(no stack)");
};

// ── Promise-chained FIFO SerialTaskQueue ───────────────────────────
// CRITICAL: C++ calls `queue.submit(task)`, NOT enqueue. Found via Proxy logging.
let queueTail: Promise<void> = Promise.resolve();
let queueTaskId = 0;
function runTask(task: { run?: () => void } | (() => void), id: number): Promise<void> {
  return queueTail = queueTail.then(async () => {
    log(`[queue] start #${id}`);
    try {
      let result: unknown;
      if (typeof task === "function") result = (task as () => unknown)();
      else if (task && typeof task.run === "function") result = task.run();
      if (result && typeof (result as Promise<unknown>).then === "function") await result;
      log(`[queue] done #${id}`);
    } catch (err) {
      log(`[queue] throw #${id}`, (err as Error)?.stack ?? err);
    }
  });
}
const fideliusQueue = {
  submit(task: { run?: () => void } | (() => void)) {
    const id = ++queueTaskId;
    log(`[queue] submit #${id}`);
    runTask(task, id);
  },
  enqueue(task: { run?: () => void } | (() => void)) {
    const id = ++queueTaskId;
    log(`[queue] enqueue #${id}`);
    runTask(task, id);
  },
  flushAndStop() { log(`[queue] flushAndStop`); },
};

// ── Delegate Proxy wrapper (use sparingly — Proxy may break Embind) ─
function passthrough<T extends object>(_name: string, delegate: T): T {
  return delegate;
}
function instrumentDelegate<T extends object>(name: string, delegate: T): T {
  return new Proxy(delegate, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;
      return function wrappedDelegateMethod(this: unknown, ...args: unknown[]) {
        log(`[${name}.${String(prop)}] called`, args.map(a => a instanceof Uint8Array ? `<${a.byteLength}B>` : typeof a === "object" && a !== null ? Object.keys(a) : a));
        let result: unknown;
        try {
          result = (value as Function).apply(this, args);
        } catch (err) {
          log(`[${name}.${String(prop)}] sync throw`, (err as Error)?.stack ?? err);
          return Promise.reject(err);
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => { log(`[${name}.${String(prop)}] resolved`, v instanceof Uint8Array ? `<${v.byteLength}B>` : v); return v; },
            (err) => { log(`[${name}.${String(prop)}] rejected`, (err as Error)?.stack ?? err); throw err; },
          );
        }
        log(`[${name}.${String(prop)}] returned`, result instanceof Uint8Array ? `<${result.byteLength}B>` : result);
        return result;
      };
    },
  });
}

// ── gRPC factory with delay-free heap buffers ──────────────────────
function gRPCWebFrame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.byteLength);
  out[0] = 0x00;
  new DataView(out.buffer).setUint32(1, body.byteLength, false);
  out.set(body, 5);
  return out;
}
function parseGRPCWebDataFrame(buf: Uint8Array): Uint8Array | null {
  if (buf.byteLength < 5 || buf[0] !== 0x00) return null;
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
  if (5 + len > buf.byteLength) return null;
  return buf.subarray(5, 5 + len);
}

// Heap-buffer leases: never freed in this debug run.
const grpcLeases: Array<{ ptr: number; len: number; label: string; ts: number }> = [];

let grpcCallNum = 0;
const ourFactory = {
  createClient: (configRaw: { endpointAddress?: string; requestPathPrefix?: string }) => {
    const config = loggingProxy("grpc.cfg", configRaw);
    log(`[grpc.createClient] endpoint=${configRaw.endpointAddress} prefix=${configRaw.requestPathPrefix}`);
    return loggingProxy("grpc.client", {
      unaryCall: async (
        methodPath: string,
        body: Uint8Array,
        optionsRaw: unknown,
        cbRaw: { onEvent?: (msg: Uint8Array | undefined, status: { statusCode: number; errorString: string }) => void } | undefined,
      ) => {
        // Wrap options too — C++ might query methods on it.
        const _options = optionsRaw && typeof optionsRaw === "object" ? loggingProxy("grpc.options", optionsRaw as object) : optionsRaw;
        const callback = cbRaw ? loggingProxy(`grpc.cb`, cbRaw) : cbRaw;
        const callId = ++grpcCallNum;
        log(`  [grpc.options keys]`, optionsRaw && typeof optionsRaw === "object" ? Object.keys(optionsRaw as object) : optionsRaw);
        const prefix = config.requestPathPrefix?.length ? `/${config.requestPathPrefix}` : "";
        const url = `${config.endpointAddress}${prefix}${methodPath}`;
        log(`[grpc.unaryCall #${callId}] ${url} body=${body.byteLength}B`);
        try {
          const respMsg = await unaryFetch(url, body);
          if (!respMsg) {
            log(`[grpc.unaryCall #${callId}] no resp → INTERNAL`);
            setTimeout(() => callback?.onEvent?.(undefined, { statusCode: 13, errorString: "no message" }), 0);
            return;
          }
          const ptr = Module._malloc(respMsg.byteLength);
          if (!ptr) throw new Error("malloc returned 0");
          const heapView = new Uint8Array(Module.HEAPU8.buffer, ptr, respMsg.byteLength);
          heapView.set(respMsg);
          grpcLeases.push({ ptr, len: respMsg.byteLength, label: methodPath, ts: Date.now() });
          log(`[grpc.unaryCall #${callId}] OK ${respMsg.byteLength}B @0x${ptr.toString(16)} (lease ${grpcLeases.length})`);
          setTimeout(() => callback?.onEvent?.(heapView, { statusCode: 0, errorString: "" }), 0);
        } catch (e) {
          log(`[grpc.unaryCall #${callId}] threw:`, (e as Error)?.stack ?? (e as Error).message);
          setTimeout(() => callback?.onEvent?.(undefined, { statusCode: 2, errorString: (e as Error).message }), 0);
        }
      },
      // The bundle's factory ALSO throws here, but that's fine in the
      // browser because something else handles. Return a no-op stub to
      // see if construct stops throwing.
      serverStreamingCall: (_methodPath: string, _body: Uint8Array, _options: unknown, callback: { onEvent?: Function } | undefined) => {
        log(`[grpc.serverStreamingCall] no-op`);
        // Pretend the stream ended cleanly with no data
        setTimeout(() => callback?.onEvent?.(undefined, { statusCode: 12 /*UNIMPLEMENTED*/, errorString: "unsupported" }), 0);
      },
      bidiStreamingCall: (_methodPath: string, _options: unknown, callback: { onEvent?: Function } | undefined) => {
        log(`[grpc.bidiStreamingCall] no-op`);
        setTimeout(() => callback?.onEvent?.(undefined, { statusCode: 12, errorString: "unsupported" }), 0);
      },
    });
  },
};

async function unaryFetch(url: string, body: Uint8Array): Promise<Uint8Array | null> {
  // Special case: if WASM is calling InitializeWebKey, our identity is already
  // registered — synthesize a successful response with our existing keys.
  // Saves a real round-trip and avoids the 401-already-registered abort path.
  if (url.includes("FideliusIdentityService/InitializeWebKey")) {
    // Parse the WASM's request: field 2 sub { f1: pubkey, f2: identityKeyId, f3: rwk, f4: version }
    // Echo the WASM's OWN identityKeyId and rwk back in the response so the
    // C++ side accepts them (they have to match what the WASM just generated).
    let identityKeyId = fidIdentityKeyId, rwk = fidRwk;
    try {
      // Find the inner submessage at field 2
      let pos = 0;
      while (pos < body.byteLength) {
        const tag = body[pos++]!;
        const wt = tag & 0x07;
        const field = tag >> 3;
        if (wt === 2) {
          let len = 0, shift = 0;
          while (true) { const b = body[pos++]!; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
          const slice = body.subarray(pos, pos + len);
          pos += len;
          if (field === 2) {
            // inner message: f1=pub, f2=identityKeyId, f3=rwk, f4=version
            let ip = 0;
            while (ip < slice.byteLength) {
              const itag = slice[ip++]!;
              const iwt = itag & 0x07;
              const ifield = itag >> 3;
              if (iwt === 2) {
                let ilen = 0, ishift = 0;
                while (true) { const b = slice[ip++]!; ilen |= (b & 0x7f) << ishift; if (!(b & 0x80)) break; ishift += 7; }
                const ibytes = slice.subarray(ip, ip + ilen);
                ip += ilen;
                if (ifield === 2) identityKeyId = new Uint8Array(ibytes);
                else if (ifield === 3) rwk = new Uint8Array(ibytes);
              } else if (iwt === 0) {
                while (slice[ip++]! & 0x80) {}
              }
            }
          }
        } else if (wt === 0) {
          while (body[pos++]! & 0x80) {}
        } else break;
      }
    } catch (e) {
      log(`  [InitializeWebKey] parse err: ${(e as Error).message}`);
    }
    log(`  [InitializeWebKey] echoing back WASM's own identityKeyId=${identityKeyId.byteLength}B rwk=${rwk.byteLength}B`);
    const out = new Uint8Array(2 + rwk.byteLength + 2 + identityKeyId.byteLength);
    let p = 0;
    out[p++] = 0x0a; out[p++] = rwk.byteLength;
    out.set(rwk, p); p += rwk.byteLength;
    out[p++] = 0x12; out[p++] = identityKeyId.byteLength;
    out.set(identityKeyId, p);
    return out;
  }
  // Route through web.snapchat.com (not us-east1-aws), with cookie jar + bearer.
  // Mirror what client.makeRpc + stripOriginReferer would do.
  const path = url.match(/\/snapchat\..+$/)?.[0] ?? url;
  const fullUrl = `https://web.snapchat.com${path}`;
  const cookieHeader = await client.jar.getCookieString("https://web.snapchat.com");
  const headers: Record<string, string> = {
    "accept": "*/*",
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    "x-user-agent": "grpc-web-javascript/0.1",
    "user-agent": client.userAgent,
    "authorization": `Bearer ${client.bearer}`,
    "cookie": cookieHeader,
    // Note: NO origin, referer, mcs-cof-ids-bin, accept-language (stripped per Fidelius gateway requirements)
  };
  log(`  → ${fullUrl}`);
  const resp = await nativeFetch(fullUrl, { method: "POST", headers, body: gRPCWebFrame(body) });
  log(`  HTTP ${resp.status} ${resp.statusText}`);
  if (!resp.ok) return null;
  const ab = await resp.arrayBuffer();
  return parseGRPCWebDataFrame(new Uint8Array(ab));
}

// ── Wire factory into WASM ─────────────────────────────────────────
const Platform = Module.shims_Platform as Record<string, Function>;
const ConfigReg = Module.config_ConfigurationRegistry as Record<string, Function>;
const GrpcManager = Module.grpc_GrpcManager as Record<string, Function>;

Platform.init({ assertionMode: 2, minLogLevel: 2 }, loggingProxy("logger", { logTimedEvent: () => {}, log: (msg: unknown) => log(`[wasm.log]`, msg) }));
log(`Platform.init OK`);

Platform.registerSerialTaskQueue(loggingProxy("queue", fideliusQueue));
Platform.installErrorReporter(loggingProxy("errReporter", { reportError: (e: unknown) => log(`[wasm.error]`, e) }));
Platform.installNonFatalReporter(loggingProxy("nonfatalReporter", { reportError: (e: unknown) => log(`[wasm.nonfatal]`, e) }));

// Each config setter takes an OBJECT with getter methods, NOT bytes.
// Per bundle: Kr(e) returns { getSystemType, getRealValue, getIntegerValue,
//   getStringValue, getBinaryValue, getBooleanValue, getConfigurationState }.
// Default values: empty/zero — signals "no override".
function makeConfig(name: string) {
  return loggingProxy(`cfg.${name}`, {
    getSystemType: () => 0,
    getRealValue: (_e: unknown) => 0,
    getIntegerValue: (_e: unknown) => 0n,
    getStringValue: (_e: unknown) => "",
    getBinaryValue: (_e: unknown) => new Uint8Array(0),
    getBooleanValue: (_e: unknown) => false,
    getConfigurationState: () => ({}),
  });
}
for (const setter of ["setCircumstanceEngine", "setCompositeConfig", "setExperiments", "setServerConfig", "setTweaks", "setUserPrefs"]) {
  const cfgName = setter.replace(/^set/, "");
  ConfigReg[setter](makeConfig(cfgName));
}
log(`config setters: object-shaped`);

const Blizzard = Module.blizzard_NativeBlizzardEventLoggerInstaller as Record<string, Function> | undefined;
Blizzard?.installBlizzardLogger?.(loggingProxy("blizzard", { logEvent: () => {} }));

GrpcManager.registerWebFactory(ourFactory);
log(`registerWebFactory OK`);

// ── Delegates with full instrumentation ────────────────────────────
// Proxy with `get` trap to log EVERY property access, including misses.
function loggingProxy<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const value = Reflect.get(t, prop, recv);
      log(`  [${name}.${String(prop)}] access ${value === undefined ? "❌ MISSING" : typeof value}`);
      return value;
    },
  });
}

// Delegates back the WASM persist + session storage with our DataStore.
// On first run, WASM completes registration and writes wrapped bytes here.
// On subsequent runs, we load them back and the WASM should skip re-registration.
const persistentStorage = loggingProxy("persist", {
  storeUserWrappedIdentityKeys(e: unknown) {
    const bytes = e as Uint8Array;
    log(`[persist.store] ${bytes?.byteLength ?? typeof e}B`);
    if (bytes instanceof Uint8Array) {
      dataStore.set("e2ee/wrapped_identity_keys", bytes).catch((err) => log(`  store err: ${(err as Error).message}`));
    }
  },
  async loadUserWrappedIdentityKeys() {
    const bytes = await dataStore.get("e2ee/wrapped_identity_keys");
    if (bytes && bytes.byteLength > 0) {
      log(`[persist.load] → [bytes(${bytes.byteLength}B)]`);
      return [bytes];
    }
    log(`[persist.load] → [] (no value)`);
    return [];
  },
});

const sessionScopedStorage = loggingProxy("session", {
  storeRootWrappingKey(e: unknown) {
    const bytes = e as Uint8Array;
    log(`[session.storeRwk] ${bytes?.byteLength ?? typeof e}B`);
    if (bytes instanceof Uint8Array) {
      dataStore.set("e2ee/root_wrapping_key", bytes).catch((err) => log(`  err: ${(err as Error).message}`));
    }
  },
  async readRootWrappingKey() {
    const bytes = await dataStore.get("e2ee/root_wrapping_key");
    if (bytes && bytes.byteLength > 0) {
      const obj: Record<number, number> = {};
      for (let i = 0; i < bytes.byteLength; i++) obj[i] = bytes[i]!;
      log(`[session.readRwk] → object(${bytes.byteLength}B)`);
      return obj;
    }
    log(`[session.readRwk] → [] (empty)`);
    return [];
  },
  async destroy() {
    log(`[session.destroy]`);
    await dataStore.delete("e2ee/root_wrapping_key");
  },
  async loadTemporaryIdentityKey() {
    const bytes = await dataStore.get("e2ee/temporary_identity_key");
    if (bytes && bytes.byteLength > 0) {
      log(`[session.loadTempKey] → bytes(${bytes.byteLength}B)`);
      return bytes;
    }
    log(`[session.loadTempKey] → undefined (no temp key)`);
    return undefined;
  },
  async clearTemporaryIdentityKey() {
    log(`[session.clearTempKey]`);
    await dataStore.delete("e2ee/temporary_identity_key");
  },
  async storeTemporaryIdentityKey(e: unknown) {
    const bytes = e as Uint8Array;
    log(`[session.storeTempKey] ${bytes?.byteLength ?? typeof e}B`);
    if (bytes instanceof Uint8Array) {
      await dataStore.set("e2ee/temporary_identity_key", bytes);
    }
  },
});

const grpcCfg = loggingProxy("grpcCfg", { apiGatewayEndpoint: "https://us-east1-aws.api.snapchat.com", grpcPathPrefix: "" });

// Try userId.id as 16-byte binary UUID instead of dashed string.
const userIdStr = blob.self?.userId ?? "527be2ff-aaec-4622-9c68-79d200b8bdc1";
const userIdBytes = new Uint8Array(16);
const hex = userIdStr.replace(/-/g, "");
for (let i = 0; i < 16; i++) userIdBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

const userId = loggingProxy("userId", { id: userIdBytes });
const tweaksOuter = loggingProxy("tweaks.outer", { tweaks: new Map<number, string>() });
const sessionCfg = loggingProxy("sessionCfg", {
  databaseLocation: ":memory:",
  userId,
  userAgentPrefix: "",
  debug: false,
  tweaks: tweaksOuter,
  // C++ calls this when KeyManager init completes — must exist as a method.
  onInitializationComplete: (...args: unknown[]) => {
    log(`[sessionCfg.onInitializationComplete] called`, ...args.map(a => a instanceof Uint8Array ? `<${a.byteLength}B>` : typeof a));
  },
});

// ── construct + watch ──────────────────────────────────────────────
const KeyManager = Module.e2ee_E2EEKeyManager as Record<string, Function>;
// Use existing fidelius identity from auth blob — no need to re-register.
const fidPub = Buffer.from(fid.publicKey, "hex");
const fidPriv = Buffer.from(fid.privateKey, "hex");
const fidIdentityKeyId = fid.identityKeyId ? Buffer.from(fid.identityKeyId, "hex") : new Uint8Array(32);
const fidRwk = fid.rwk ? Buffer.from(fid.rwk, "hex") : new Uint8Array(16);
log(`existing fidelius identity from blob: pub=${fidPub.byteLength}B priv=${fidPriv.byteLength}B identityKeyId=${fidIdentityKeyId.byteLength}B rwk=${fidRwk.byteLength}B v=${fid.version}`);

log(`\n=== constructWithKey (using existing identity from auth blob) ===`);
let km: { getCurrentUserKeyAsync?: () => Promise<unknown>; registerCurrentUserKeyWithServer?: () => Promise<unknown> } | undefined;
try {
  // C++ accesses keyArg.length — keyArg is expected as an ARRAY, not object.
  // Try with identityKeyId wrapped as {data: ...} (Djinni common UUID shape)
  const keyArg = [
    fidPub,                              // cleartextPublicKey
    fidPriv,                             // cleartextPrivateKey
    { data: fidIdentityKeyId },          // identityKeyId — wrapped UUID
    BigInt(fid.version ?? 10),           // version
  ];
  km = (KeyManager.constructWithKey as Function)(
    grpcCfg, persistentStorage, sessionScopedStorage, sessionCfg, keyArg, 1, 1,
  ) as typeof km;
  log(`✅ constructWithKey OK: ${km && typeof km === "object" ? Object.keys(km as object).join(",") : "??"}`);
} catch (e) {
  log(`constructWithKey threw:`, (e as Error)?.message?.slice(0, 300));
  log(`Falling back to constructPostLogin...`);
  try {
    km = (KeyManager.constructPostLogin as Function)(
      grpcCfg, persistentStorage, sessionScopedStorage, sessionCfg, 1, 1,
    ) as typeof km;
    log(`✅ constructPostLogin OK: ${km && typeof km === "object" ? Object.keys(km as object).join(",") : "??"}`);
  } catch (e2) {
    log(`constructPostLogin also threw:`, (e2 as Error)?.message?.slice(0, 300));
    process.exit(1);
  }
}

log(`\n=== waiting 3s after construct (watching for deferred work) ===`);
await new Promise((r) => setTimeout(r, 3000));

log(`\n=== calling getCurrentUserKeyAsync ===`);
try {
  const result = await km!.getCurrentUserKeyAsync!();
  log(`  → result:`, result);
} catch (e) {
  log(`  threw:`, (e as Error)?.stack ?? (e as Error).message);
}

log(`\ndone — grpcCalls=${grpcCallNum} queueTasks=${queueTaskId} leases=${grpcLeases.length}`);
process.exit(0);
