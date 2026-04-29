/**
 * Mint a Fidelius identity by booting the chat-bundle Emscripten WASM
 * and calling `e2ee_E2EEKeyManager.generateKeyInitializationRequest`.
 *
 * The WASM generates a fresh P-256 keypair + RWK locally; the SDK
 * never inputs randomness from JS so the keys come straight from the
 * WASM's CSPRNG. Once we have the cleartext material, the higher-
 * level `auth/login.ts` flow registers the public key with Snap via
 * the Fidelius gRPC service.
 *
 * Boot cost: ~12 MB WASM + 1488 webpack modules + ~250ms init. Only
 * runs on first login; `fromAuth(blob)` skips this entirely by
 * deserializing the saved keys instead.
 *
 * The boot path mirrors auth/kameleon.ts but for the chat bundle:
 *   - chat webpack runtime (9989a) with `o`-closure leak patch
 *   - main bundle (9846a) source-patched to swap empty Node-stub
 *     modules (91903 → real Buffer, 36675 → real fs)
 *   - Module factory at module 86818, fed our pre-fetched WASM bytes
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../shims/runtime.ts";
import { installWebpackCapture } from "../shims/webpack-capture.ts";

export type FideliusIdentity = {
  /** SEC1-uncompressed P-256 public key (65 bytes, 0x04 prefix). */
  cleartextPublicKey: Uint8Array;
  /** P-256 private key (32 bytes). */
  cleartextPrivateKey: Uint8Array;
  /** Server-side identifier for this key (32 bytes). */
  identityKeyId: Uint8Array;
  /** Root wrapping key (16 bytes) — locally encrypts persisted keys. */
  rwk: Uint8Array;
  /** Protocol version (10 = "TEN", current as of 2026-04). */
  version: number;
};

export type MintFideliusOpts = {
  /** Defaults to vendor/snap-bundle relative to this file. */
  bundleDir?: string;
};

let cachedIdentityModulePromise: Promise<{ km: KeyManagerStatics }> | null = null;

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

/**
 * Boot the chat-bundle WASM once per process and yield a fresh Fidelius
 * identity each call. The boot result is cached — subsequent mints just
 * re-run `generateKeyInitializationRequest` against the same Module.
 */
export async function mintFideliusIdentity(opts: MintFideliusOpts = {}): Promise<FideliusIdentity> {
  const { km } = await getOrBootKeyManager(opts);
  // Algorithm 1 = "TEN" (v10) — matches what browsers send at first
  // login. 0 produces the older v9 shape (proto field 1, no RWK in
  // request) which Snap's server still accepts but we standardise on
  // current.
  const result = km.generateKeyInitializationRequest(1);
  return {
    cleartextPublicKey: toBytes(result.keyInfo.identity.cleartextPublicKey),
    cleartextPrivateKey: toBytes(result.keyInfo.identity.cleartextPrivateKey),
    identityKeyId: toBytes(result.keyInfo.identity.identityKeyId.data),
    rwk: toBytes(result.keyInfo.rwk.data),
    version: result.keyInfo.identity.version,
  };
}

async function getOrBootKeyManager(opts: MintFideliusOpts): Promise<{ km: KeyManagerStatics }> {
  if (cachedIdentityModulePromise) return cachedIdentityModulePromise;
  cachedIdentityModulePromise = bootOnce(opts);
  return cachedIdentityModulePromise;
}

async function bootOnce(opts: MintFideliusOpts): Promise<{ km: KeyManagerStatics }> {
  const bundleDir = opts.bundleDir ?? defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");
  const runtimePath = join(chatDw, "9989a7c6c88a16ebf19d.js");
  const mainPath = join(chatDw, "9846a7958a5f0bee7197.js");
  const wasmPath = join(chatDw, "e4fa90570c4c2d9e59c1.wasm");

  installShims({ url: "https://www.snapchat.com/web" });
  installWebpackCapture();

  // happy-dom doesn't auto-create #root; chat bundle's top-level mounts
  // a React app and crashes without one.
  const doc = (globalThis as unknown as { document?: { body?: { innerHTML: string } } }).document;
  if (doc?.body) doc.body.innerHTML = '<div id="root"></div>';

  // Load chat-bundle webpack runtime — patch `o`-closure to expose the
  // module map as globalThis.__snapcap_p, same trick as kameleon.
  let runtimeSrc = readFileSync(runtimePath, "utf8");
  if (!runtimeSrc.includes("o.m=n,o.amdO={}")) {
    throw new Error("chat-bundle runtime patch site not found");
  }
  runtimeSrc = runtimeSrc.replace("o.m=n,o.amdO={}", "globalThis.__snapcap_p=o,o.m=n,o.amdO={}");
  try {
    new Function("module", "exports", "require", runtimeSrc)({ exports: {} }, {}, () => {
      throw new Error("require not available (chat runtime)");
    });
  } catch {
    // chat runtime throws on top-level eval (calls into bootstrap that
    // expects a browser env); module map is registered before throw.
  }

  // Pre-stage real Buffer/fs into globals so the patched main bundle's
  // stub modules (91903, 36675) can hand them out.
  const fsModule = await import("node:fs");
  const g = globalThis as unknown as Record<string, unknown>;
  g.__snapcap_node_buffer = { Buffer };
  g.__snapcap_node_fs = fsModule;

  let mainSrc = readFileSync(mainPath, "utf8");
  mainSrc = mainSrc.replace("91903(){}", "91903(e,t){t.Buffer=globalThis.__snapcap_node_buffer.Buffer}");
  mainSrc = mainSrc.replace("36675(){}", "36675(e,t){Object.assign(t,globalThis.__snapcap_node_fs)}");
  try {
    new Function("module", "exports", "require", mainSrc)({ exports: {} }, {}, () => {
      throw new Error("require not available (chat main)");
    });
  } catch {
    // expected — main does top-level work that needs a browser.
  }

  const w = globalThis as unknown as {
    __snapcap_p?: { (id: string): unknown; m: Record<string, Function> };
  };
  if (!w.__snapcap_p) {
    throw new Error("chat-bundle webpack runtime did not expose __snapcap_p — patch may have failed");
  }
  const wreq = w.__snapcap_p;

  const factoryMod = wreq("86818") as { A?: Function };
  const factory = factoryMod.A;
  if (typeof factory !== "function") {
    throw new Error("chat-bundle module 86818 did not yield Emscripten factory");
  }

  const wasmBytes = readFileSync(wasmPath);

  let runtimeInitDone = false;
  const moduleEnv: Record<string, unknown> = {
    onRuntimeInitialized: () => {
      runtimeInitDone = true;
    },
    instantiateWasm: (
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance, mod?: WebAssembly.Module) => void,
    ): unknown => {
      WebAssembly.instantiate(wasmBytes, imports).then((res) => {
        successCallback(res.instance, res.module);
      });
      return {};
    },
    onAbort: (reason: unknown) => {
      throw new Error(`Fidelius WASM aborted: ${String(reason)}`);
    },
    print: () => {},
    printErr: () => {},
    locateFile: (name: string) => name,
  };

  factory(moduleEnv);

  // Module.ready Promise doesn't resolve cleanly through happy-dom;
  // poll runtimeInitDone instead. Embind classes are fully populated
  // by the time onRuntimeInitialized fires.
  const startedAt = Date.now();
  while (!runtimeInitDone) {
    if (Date.now() - startedAt > 30_000) {
      throw new Error("Fidelius WASM init timed out (>30s)");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const km = (moduleEnv as { e2ee_E2EEKeyManager?: KeyManagerStatics }).e2ee_E2EEKeyManager;
  if (!km || typeof km.generateKeyInitializationRequest !== "function") {
    throw new Error("Fidelius WASM did not expose e2ee_E2EEKeyManager.generateKeyInitializationRequest");
  }
  return { km };
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
}

function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  if (x && typeof x === "object") {
    const values = Object.values(x as Record<string, number>);
    return new Uint8Array(values);
  }
  throw new Error("expected bytes-like, got " + typeof x);
}
