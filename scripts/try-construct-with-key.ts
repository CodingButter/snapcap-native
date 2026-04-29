/**
 * Try `e2ee_E2EEKeyManager.constructWithKey(...)` — pass our already-
 * minted key directly so the WASM should skip the registration gRPC
 * call (which crashed with Out-of-bounds memory access on the gRPC
 * client's C++ vtable in our earlier attempt).
 *
 * If this returns a working KeyManager, we can proceed to
 * messaging_Session.create() and get decrypt-capable Session.
 */
import { readFileSync } from "node:fs";
import { mintFideliusIdentity } from "../src/auth/fidelius-mint.ts";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

// Load our existing identity (we're already registered).
const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius;
if (!fid) throw new Error("no fidelius in blob — log in fresh first");

// Force-boot the WASM via mint (yields the same Module the chat bundle uses).
process.env.SNAPCAP_EXPOSE_FIDELIUS_MODULE = "1";
await mintFideliusIdentity();
const Module = (globalThis as unknown as { __snapcap_fidelius_module?: Record<string, unknown> }).__snapcap_fidelius_module;
if (!Module) throw new Error("Module not exposed");

const km = Module.e2ee_E2EEKeyManager as Record<string, Function>;

// Set up minimal delegates (in-memory; constructWithKey shouldn't need
// them but the type signature requires them).
let storedIdentity: unknown = undefined;
let storedRwk: unknown = undefined;
let storedTempKey: unknown = undefined;

const persistentStorage = {
  storeUserWrappedIdentityKeys(e: unknown) { log(`  persistent.store called`); storedIdentity = e; },
  loadUserWrappedIdentityKeys() {
    log(`  persistent.load → ${storedIdentity ? "have key" : "null"}`);
    return Promise.resolve(storedIdentity);
  },
};
const sessionScopedStorage = {
  storeRootWrappingKey(e: unknown) { log(`  session.storeRwk`); storedRwk = e; },
  readRootWrappingKey() { log(`  session.readRwk → ${storedRwk ? "have" : "null"}`); return Promise.resolve(storedRwk); },
  destroy() { storedRwk = undefined; return Promise.resolve(); },
  loadTemporaryIdentityKey() { return Promise.resolve(storedTempKey); },
  clearTemporaryIdentityKey() { storedTempKey = undefined; return Promise.resolve(); },
};

// Set up gRPC factory — log every interaction so we know if it's invoked.
const Platform = Module.shims_Platform as Record<string, Function>;
const ConfigReg = Module.config_ConfigurationRegistry as Record<string, Function>;
const GrpcManager = Module.grpc_GrpcManager as Record<string, Function>;

Platform.init({ assertionMode: 2, minLogLevel: 2 }, { logTimedEvent: () => {}, log: () => {} });
log(`Platform.init OK`);

// Register a serial task queue. Bundle uses this for cross-thread
// dispatching; without it Djinni async callbacks may have nowhere to
// run and the C++ side might fall back to indirect calls that fail.
try {
  Platform.registerSerialTaskQueue({
    enqueue: (task: { run?: () => void } | (() => void)) => {
      // Run the task on next microtask. Some Djinni tasks have a `.run()`
      // method; others might be plain functions.
      queueMicrotask(() => {
        if (typeof task === "function") task();
        else if (task && typeof task.run === "function") task.run();
      });
    },
    flushAndStop: () => {},
  });
  log(`registerSerialTaskQueue OK`);
} catch (e) {
  log(`registerSerialTaskQueue threw: ${(e as Error).message.slice(0, 200)}`);
}

Platform.installErrorReporter({ reportError: (e: unknown) => log(`  [error] ${JSON.stringify(e).slice(0,200)}`) });
Platform.installNonFatalReporter({ reportError: (e: unknown) => log(`  [nonfatal] ${JSON.stringify(e).slice(0,200)}`) });
for (const setter of ["setCircumstanceEngine","setCompositeConfig","setExperiments","setServerConfig","setTweaks","setUserPrefs"]) {
  ConfigReg[setter](new Uint8Array(0));
}

// Also try blizzard logger install — bundle calls installBlizzardLogger
const Blizzard = Module.blizzard_NativeBlizzardEventLoggerInstaller as Record<string, Function> | undefined;
if (Blizzard?.installBlizzardLogger) {
  try {
    Blizzard.installBlizzardLogger({
      logEvent: () => {},
    });
    log(`installBlizzardLogger OK`);
  } catch (e) {
    log(`installBlizzardLogger threw: ${(e as Error).message.slice(0, 200)}`);
  }
}

GrpcManager.registerWebFactory({
  createClient: (config: unknown) => {
    log(`  [grpc.createClient] ${JSON.stringify(config).slice(0,80)}`);
    return {
      unaryCall(methodPath: string, body: Uint8Array, options: unknown, callback: unknown) {
        log(`  [grpc.unaryCall] method=${methodPath} body=${body?.byteLength}B  cb=${typeof callback}`);
        // Don't invoke callback — see if the C++ side gives up gracefully.
      },
      serverStreamingCall() { throw new Error("unsupported"); },
      bidiStreamingCall() { throw new Error("unsupported"); },
    };
  },
});

// The minted key we want the WASM to use.
const minted = await mintFideliusIdentity();
log(`\nminted (for use as ${fid.publicKey.slice(0,16)}…): pub=${minted.cleartextPublicKey.byteLength}B priv=${minted.cleartextPrivateKey.byteLength}B`);

// constructWithKey(grpcCfg, persistentDelegate, sessionDelegate, sessionCfg, key, upgradeMode, version)
const grpcCfg = { apiGatewayEndpoint: "https://us-east1-aws.api.snapchat.com", grpcPathPrefix: "" };
const sessionCfg = {
  databaseLocation: ":memory:",
  userId: { id: blob.self?.userId ?? "527be2ff-aaec-4622-9c68-79d200b8bdc1" },
  userAgentPrefix: "",
  debug: false,
  tweaks: { tweaks: new Map() },
};

// Try several shapes for the `key` arg.
const keyCandidates: Array<{ label: string; key: unknown }> = [
  { label: "{cleartextPublicKey,cleartextPrivateKey,version}", key: { cleartextPublicKey: minted.cleartextPublicKey, cleartextPrivateKey: minted.cleartextPrivateKey, version: 10 } },
  { label: "{publicKey,privateKey,version}", key: { publicKey: minted.cleartextPublicKey, privateKey: minted.cleartextPrivateKey, version: 10 } },
  { label: "minted whole", key: { cleartextPublicKey: minted.cleartextPublicKey, cleartextPrivateKey: minted.cleartextPrivateKey, identityKeyId: { data: minted.identityKeyId }, version: 10 } },
];

for (const cand of keyCandidates) {
  log(`\n--- constructWithKey(${cand.label}) ---`);
  try {
    const result = (km.constructWithKey as Function).call(km, grpcCfg, persistentStorage, sessionScopedStorage, sessionCfg, cand.key, 1, 1);
    log(`  → ${typeof result}: ${result && typeof result === "object" ? Object.keys(result as object).join(",") : String(result)}`);
    if (result && typeof result === "object") {
      // Try to call a method on it
      const r = result as Record<string, Function>;
      if (typeof r.getCurrentUserKeyAsync === "function") {
        log(`  calling getCurrentUserKeyAsync...`);
        try {
          const k = await r.getCurrentUserKeyAsync();
          log(`  → ${typeof k} ${k ? Object.keys(k as object).join(",") : "null"}`);
        } catch (e) { log(`  threw: ${(e as Error).message.slice(0, 150)}`); }
      }
      log(`  ✅ got a manager! exiting.`);
      process.exit(0);
    }
  } catch (e) {
    log(`  threw: ${(e as Error).message.slice(0, 200)}`);
  }
}

// Probe whether Embind classes have hidden `.implement` / `.extend` for JS-impl
log("\n--- probing for .implement / .extend on gRPC interfaces ---");
for (const name of ["grpc_UnifiedGrpcService", "grpc_GrpcWebFactory", "e2ee_KeyPersistentStorageDelegate", "e2ee_SessionScopedStorageDelegate"]) {
  const klass = Module[name] as Record<string, unknown> & Function;
  if (!klass) { log(`  ${name}: not present`); continue; }
  // Check ALL property names (including non-enumerable)
  const all = Object.getOwnPropertyNames(klass);
  const interesting = all.filter((k) => !["length", "name", "prototype", "argCount", "arguments", "caller"].includes(k));
  log(`  ${name}: own props = ${interesting.length ? interesting.join(",") : "(none)"}`);
  // Check Symbol-keyed
  const symbols = Object.getOwnPropertySymbols(klass);
  if (symbols.length) log(`    + ${symbols.length} symbol keys`);
  // Maybe .extend is on the prototype itself
  const protoOwn = klass.prototype ? Object.getOwnPropertyNames(klass.prototype).filter((k) => !["constructor", "nativeDestroy"].includes(k)) : [];
  if (protoOwn.length) log(`    proto methods (excl. constructor/nativeDestroy): ${protoOwn.join(",")}`);
}

log("\n❌ none of the key shapes produced a working KeyManager");
process.exit(1);
