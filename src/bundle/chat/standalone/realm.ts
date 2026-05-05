/**
 * Boot + cache the standalone chat WASM realm.
 *
 * Why a second WASM instance: the bundle's main top-level eval auto-boots
 * its own copy of the chat WASM into the captured `__SNAPCAP_CHAT_MODULE`.
 * That instance lives in a realm where the Worker shim is neutered (so
 * messaging session bring-up doesn't loop in metrics + sentry traffic),
 * and the noop'd worker bridge corrupts internal state such that the
 * static Embind call `e2ee_E2EEKeyManager.generateKeyInitializationRequest`
 * aborts. A SECOND, independent WASM instance booted in a fresh
 * `vm.Context` has a clean Embind realm (Embind state is per-realm — see
 * `bundle/chat-wasm-boot.ts:14-19`) and a moduleEnv WE control end-to-end,
 * so the static mint succeeds.
 *
 * Approach (mirrors the legacy commit d63b452):
 *   1. Create a fresh `vm.Context` with the minimum globals the bundle's
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
 *
 * Boot cost: ~12 MB WASM compile + ~1488 webpack module registrations +
 * ~250 ms init. Cached on `sandbox.fideliusMintBoot` so repeat reaches
 * against the same `Sandbox` share one instance, but two `SnapcapClient`
 * instances each get their own realm (multi-tenant isolation).
 *
 * @internal
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "../../../shims/sandbox.ts";
import { installMintRealmStubs } from "./realm-globals.ts";
import type {
  KeyManagerStatics,
  StandaloneChatModule,
  StandaloneChatRealm,
  StandaloneChatWreq,
} from "./types.ts";

/**
 * Get the full mint-realm payload — moduleEnv, vm.Context, and the
 * webpack require leaked onto that context's global. Lazy-boots on first
 * call (same cached promise as `mintFideliusIdentity`).
 *
 * Cached per-{@link Sandbox} on `sandbox.fideliusMintBoot` — each
 * `SnapcapClient` instance owns its own mint realm; multi-tenant runners
 * never see one tenant's identity bleed into another's session.
 *
 * `session/setup.ts` uses this to run the f16f14e3 worker chunk in the
 * same vm.Context that hosts our pre-minted WASM Module. The chunk's
 * loadWasm path is source-patched away and our Module is injected into
 * `un.wasmModule` so `En.createMessagingSession` finds the same Embind
 * classes the standalone mint WASM registered.
 *
 * @internal
 */
export async function getStandaloneChatRealm(sandbox: Sandbox): Promise<StandaloneChatRealm> {
  const { moduleEnv, context, wreq } = await getOrBootKeyManager(sandbox);
  return { moduleEnv, context, wreq };
}

/**
 * Lazy-boot orchestrator: caches the boot promise on the sandbox so
 * concurrent reaches (mint + messaging session bring-up firing in
 * parallel) all share one Module instance, AND drops the cache on
 * rejection so a follow-up call can retry.
 *
 * @internal
 */
export async function getOrBootKeyManager(sandbox: Sandbox): Promise<{
  km: KeyManagerStatics;
  moduleEnv: StandaloneChatModule;
  context: vm.Context;
  wreq: StandaloneChatWreq;
}> {
  if (sandbox.fideliusMintBoot) return sandbox.fideliusMintBoot;
  const boot = bootStandaloneMintWasm();
  sandbox.fideliusMintBoot = boot;
  // If the boot rejects, drop the cache so a retry can re-attempt.
  boot.catch(() => {
    if (sandbox.fideliusMintBoot === boot) sandbox.fideliusMintBoot = undefined;
  });
  return boot;
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "..", "..", "vendor", "snap-bundle");
}

/**
 * Boot the chat-bundle messaging WASM in a clean vm.Context, returning a
 * handle to its `e2ee_E2EEKeyManager` static class. The fresh realm
 * guarantees clean Embind registration (no collision with the bundle's
 * own auto-instantiated Module).
 *
 * @internal
 */
async function bootStandaloneMintWasm(): Promise<{
  km: KeyManagerStatics;
  moduleEnv: StandaloneChatModule;
  context: vm.Context;
  wreq: StandaloneChatWreq;
}> {
  const bundleDir = defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");
  const runtimePath = join(chatDw, "9989a7c6c88a16ebf19d.js");
  const mainPath = join(chatDw, "9846a7958a5f0bee7197.js");
  const wasmPath = join(chatDw, "e4fa90570c4c2d9e59c1.wasm");

  const context = vm.createContext({});
  const ctxGlobal = vm.runInContext("globalThis", context) as Record<string, unknown>;
  installMintRealmStubs(ctxGlobal);

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
      "standalone realm: chat-bundle runtime patch site `o.m=n,o.amdO={}` not found — bundle version may have shifted",
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
      "standalone realm: chat-bundle webpack runtime did not expose __snapcap_p — runtime patch may have failed to apply",
    );
  }
  if (!wreq.m["86818"]) {
    throw new Error(
      "standalone realm: chat-bundle module 86818 (Emscripten Module factory) not registered — main eval may have thrown too early",
    );
  }

  // ── Step 3: resolve module 86818's factory (Emscripten Module ctor) ─
  const factoryMod = wreq("86818") as { A?: Function; default?: Function } & Record<string, unknown>;
  const factory = (factoryMod.A ?? factoryMod.default ?? factoryMod) as Function;
  if (typeof factory !== "function") {
    throw new Error(
      `standalone realm: chat-bundle module 86818 did not yield a callable factory; shape: ${Object.keys(factoryMod).join(",")}`,
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
        process.stderr.write(`[standalone-realm wasm-err] ${s}\n`);
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
      throw new Error("standalone realm: WASM init timed out (>30s waiting for onRuntimeInitialized)");
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  const km = (moduleEnv as { e2ee_E2EEKeyManager?: KeyManagerStatics }).e2ee_E2EEKeyManager;
  if (!km || typeof km.generateKeyInitializationRequest !== "function") {
    throw new Error(
      "standalone realm: WASM did not expose e2ee_E2EEKeyManager.generateKeyInitializationRequest — Embind shape may have shifted",
    );
  }
  return {
    km,
    moduleEnv: moduleEnv as StandaloneChatModule,
    context,
    wreq: wreq as StandaloneChatWreq,
  };
}
