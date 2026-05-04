/**
 * Boot the chat-bundle Emscripten WASM in the sandbox realm.
 *
 * Capture-only: the chat bundle's own top-level eval drives webpack
 * module 51867's `N(e)` → module 86818's factory `o`, which fetches
 * `e4fa90570c4c2d9e59c1.wasm`, instantiates it, and registers ~74 Embind
 * classes (`messaging_Session`, `messaging_StatelessSession`,
 * `messaging_IdentityDelegate`, `messaging_RecipientProvider`,
 * `e2ee_E2EEKeyManager`, etc.) onto its Module instance. We source-patch
 * 86818's factory in `chat-loader.ts` to expose that Module as
 * `globalThis.__SNAPCAP_CHAT_MODULE`; here we just wait for the
 * runtime-initialized flag to flip and hand the populated reference back.
 *
 * Why we don't call the factory ourselves anymore: a second factory call
 * inside the same realm re-runs every `_embind_register_class` against
 * the realm-global Embind registry and aborts with
 * `Cannot register public name 'talkcorev3_AsyncTask' twice` — the
 * registry doesn't tolerate duplicates.
 *
 * Idempotent: cached after first call.
 */
import { Sandbox } from "../shims/sandbox.ts";
import { installWebpackCapture } from "../shims/webpack-capture.ts";
import { ensureChatBundle } from "./chat-loader.ts";

/**
 * Options for {@link bootChatWasm}.
 *
 * @internal Bundle-layer config; consumers don't construct this.
 */
export type ChatWasmBootOpts = {
  /** Defaults to vendor/snap-bundle relative to this file. */
  bundleDir?: string;
};

/**
 * Boot the chat WASM once per Sandbox. Cached on `sandbox.chatWasmBoot`
 * so a fresh Sandbox instantiates its own messaging WASM (with its own
 * Embind classes — `messaging_Session`, `e2ee_E2EEKeyManager`, etc.).
 *
 * `sandbox` is required: the Emscripten factory at chat-bundle module
 * 86818 lives inside this sandbox's vm.Context, and the resulting
 * moduleEnv contains sandbox-realm Embind classes that callers will
 * use through this same sandbox.
 *
 * @internal Bundle-layer loader; called from `auth/*` during messaging
 * session bring-up. Public consumers should not invoke directly.
 * @param sandbox - the per-instance {@link Sandbox} that will host the WASM instance
 * @param opts - optional bundle directory override
 * @returns the Emscripten `moduleEnv` containing the registered Embind classes
 * @throws when the bundle never auto-instantiates a Module or runtime init
 *   exceeds the 30s timeout
 */
export async function bootChatWasm(
  sandbox: Sandbox,
  opts: ChatWasmBootOpts = {},
): Promise<{ moduleEnv: Record<string, unknown> }> {
  if (sandbox.chatWasmBoot) {
    return sandbox.chatWasmBoot as Promise<{ moduleEnv: Record<string, unknown> }>;
  }
  const promise = bootOnce(sandbox, opts);
  sandbox.chatWasmBoot = promise;
  return promise;
}

async function bootOnce(
  sandbox: Sandbox,
  _opts: ChatWasmBootOpts,
): Promise<{ moduleEnv: Record<string, unknown> }> {
  installWebpackCapture(sandbox);

  // Trigger the bundle's top-level eval; this is what kicks off the
  // bundle's own webpack module 51867 → 86818 factory call.
  await ensureChatBundle(sandbox);

  // Poll for the captured Module reference + runtime-initialized flag.
  // Embind class registration completes inside the WASM init path that
  // ends in the factory's `Yn()` (run) call; `calledRun` is the
  // Emscripten flag that flips when run() finishes successfully.
  const startedAt = Date.now();
  while (true) {
    const captured = sandbox.getGlobal<Record<string, unknown> | undefined>(
      "__SNAPCAP_CHAT_MODULE",
    );
    if (captured && (captured.calledRun || captured.messaging_Session)) {
      defangDeprecationGetters(captured);
      return { moduleEnv: captured };
    }
    if (Date.now() - startedAt > 30_000) {
      throw new Error(
        "chat WASM init timed out (>30s) — bundle did not finish populating __SNAPCAP_CHAT_MODULE",
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * After Emscripten startup completes, the Module gets a set of
 * deprecation getters defined as `Object.defineProperty(o, X, { get: abort })`
 * for legacy names (`arguments`, `thisProgram`, `quit`, etc.). Reading
 * any of them aborts the program. The bundle's own code never touches
 * these names, so the bundle is fine — but downstream consumers that
 * enumerate the Module (e.g. Zustand's `setState` deep-copying the
 * `wasm.module` slot) will hit the abort. Replace each guarded name with
 * a plain `undefined` value so enumeration is harmless.
 */
function defangDeprecationGetters(m: Record<string, unknown>): void {
  for (const k of Object.getOwnPropertyNames(m)) {
    const desc = Object.getOwnPropertyDescriptor(m, k);
    if (desc && typeof desc.get === "function" && desc.configurable && !desc.set) {
      // Heuristic: Emscripten's deprecation guards are configurable
      // get-only accessors that throw `abort(...)` when read. Replace
      // each with a plain `undefined` value so consumers (Zustand's
      // setState, JSON.stringify probes, etc.) can enumerate the Module
      // without aborting.
      try {
        Object.defineProperty(m, k, { value: undefined, writable: true, configurable: true, enumerable: false });
      } catch {
        /* tolerate — leave as-is if redefinition refused */
      }
    }
  }
}
