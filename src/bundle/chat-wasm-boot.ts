/**
 * Boot the chat-bundle Emscripten WASM in the sandbox realm.
 *
 * Direct main-thread instantiation via webpack module 86818's factory,
 * mirroring `accounts-loader.ts`. Pre-fetched `e4fa…wasm` bytes are fed
 * through the Emscripten `instantiateWasm` hook so we never need
 * `WebAssembly.instantiateStreaming` (sandbox doesn't ship it) and never
 * spawn a Web Worker (we don't have one).
 *
 * Resurrected from commit 2aa89ca:src/auth/fidelius-mint.ts. The legacy
 * file additionally minted a Fidelius identity via
 * `e2ee_E2EEKeyManager.generateKeyInitializationRequest(1)`; we don't do
 * that here because Snap's own bundle code, once the WASM is up, drives
 * Fidelius identity generation as part of session bring-up.
 *
 * Side-effects: 74 Embind classes register on `moduleEnv` (messaging_
 * Session, messaging_StatelessSession, messaging_IdentityDelegate,
 * messaging_RecipientProvider, e2ee_E2EEKeyManager, etc.). The Module
 * factory's preRun / onRuntimeInitialized / postRun all fire.
 *
 * Idempotent: cached after first call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../shims/runtime.ts";
import { installWebpackCapture } from "../shims/webpack-capture.ts";
import { ensureChatBundle } from "./chat-loader.ts";

export type ChatWasmBootOpts = {
  /** Defaults to vendor/snap-bundle relative to this file. */
  bundleDir?: string;
};

let cachedBootPromise: Promise<{ moduleEnv: Record<string, unknown> }> | null = null;

/**
 * Boot the chat WASM once per process. Returns the populated
 * `moduleEnv` once `onRuntimeInitialized` has fired.
 */
export async function bootChatWasm(
  opts: ChatWasmBootOpts = {},
): Promise<{ moduleEnv: Record<string, unknown> }> {
  if (cachedBootPromise) return cachedBootPromise;
  cachedBootPromise = bootOnce(opts);
  return cachedBootPromise;
}

async function bootOnce(
  opts: ChatWasmBootOpts,
): Promise<{ moduleEnv: Record<string, unknown> }> {
  const bundleDir = opts.bundleDir ?? defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");
  const wasmPath = join(chatDw, "e4fa90570c4c2d9e59c1.wasm");

  // installShims is first-call-wins; the SnapcapClient ctor seeds the
  // singleton with its DataStore, so opts here would be ignored anyway.
  // Calling it for safety guarantees a sandbox exists if this function
  // is invoked standalone (e.g. from a probe script).
  const sandbox = installShims({});
  installWebpackCapture();

  ensureChatBundle({ bundleDir });

  const wreq = sandbox.getGlobal<{ (id: string): unknown; m: Record<string, Function> }>("__snapcap_chat_p");
  if (!wreq) {
    throw new Error("chat-bundle webpack runtime did not expose __snapcap_chat_p — ensureChatBundle must run first");
  }

  const factoryMod = wreq("86818") as { A?: Function };
  const factory = factoryMod.A;
  if (typeof factory !== "function") {
    throw new Error("chat-bundle module 86818 did not yield Emscripten factory");
  }

  const wasmBytes = readFileSync(wasmPath);

  let runtimeInitDone = false;
  let abortReason: string | null = null;
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
      abortReason = String(reason);
    },
    print: () => {},
    printErr: () => {},
    locateFile: (name: string) => name,
  };

  factory(moduleEnv);

  // Module.ready Promise doesn't always resolve through our shim env;
  // poll the flag onRuntimeInitialized sets. Embind classes are fully
  // registered on moduleEnv by then.
  const startedAt = Date.now();
  while (!runtimeInitDone) {
    if (abortReason !== null) {
      throw new Error(`chat WASM aborted: ${abortReason}`);
    }
    if (Date.now() - startedAt > 30_000) {
      throw new Error("chat WASM init timed out (>30s)");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // Expose for debug/probe scripts.
  if (process.env.SNAPCAP_EXPOSE_CHAT_WASM_MODULE) {
    sandbox.setGlobal("__snapcap_chat_wasm_module", moduleEnv);
  }

  return { moduleEnv };
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
}
