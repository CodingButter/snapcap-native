/**
 * Idempotent bundle bring-up.
 *
 * Loads kameleon (which loads the accounts bundle as a side-effect —
 * exposing `__SNAPCAP_LOGIN_CLIENT_IMPL`, unaryFactory in module 98747,
 * etc.), patches the sandbox `location` so chat bundle's pathname
 * guard accepts the realm, then loads the chat bundle (which registers
 * ~1488 modules including 94704, the Zustand auth store), then boots
 * the chat-bundle messaging WASM and injects the worker-proxy facade.
 *
 * Per-context marker `_bundlesLoaded` short-circuits subsequent calls.
 *
 * @internal
 */
import { ensureChatBundle } from "../../bundle/chat-loader.ts";
import { bootChatWasm } from "../../bundle/chat-wasm-boot.ts";
import { getKameleon } from "../../bundle/accounts-loader.ts";
import { chatStore } from "../../bundle/register.ts";
import { makeWorkerProxyFacade } from "../../bundle/worker-proxy-facade.ts";
import type { ClientContext } from "../_context.ts";
import { patchSandboxLocationToWeb } from "./patch-location.ts";

/**
 * Idempotent bundle bring-up. Loads kameleon (which loads the accounts
 * bundle as a side-effect — exposing `__SNAPCAP_LOGIN_CLIENT_IMPL`,
 * unaryFactory in module 98747, etc.), patches the sandbox `location`
 * so chat bundle's pathname guard accepts the realm, then loads the
 * chat bundle (which registers ~1488 modules including 94704, the
 * Zustand auth store).
 *
 * Per-context marker `_bundlesLoaded` short-circuits subsequent calls.
 *
 * @internal
 */
export async function bringUp(ctx: ClientContext): Promise<void> {
  if (ctx._bundlesLoaded) return;

  // 1. Boot kameleon — this loads the accounts bundle and runs the
  //    `__SNAPCAP_LOGIN_CLIENT_IMPL` source-patch as a side-effect.
  //    Sandbox is owned by SnapcapClient; ctx.sandbox provides isolation
  //    per-instance (kameleon Module is cached on the sandbox itself).
  await getKameleon(ctx.sandbox, { page: "www_login" });

  // 2. Patch sandbox `self.location.pathname` → "/web" so the chat
  //    bundle's module 13094 pathname guard ("Base path is not in the
  //    beginning of the pathname") doesn't throw at top-level eval.
  patchSandboxLocationToWeb(ctx);

  // 3. Load + prime chat bundle. `ensureChatBundle` includes priming of
  //    module 10409 (HY/JY/JZ codecs) and module 94704 (Zustand store
  //    M.getState) — both required for any register.ts getter to work.
  try {
    await ensureChatBundle(ctx.sandbox);
  } catch {
    // Chat bundle's main top-level may throw on browser-only init paths
    // (window.location reads, missing #__NEXT_DATA__, etc.). Module
    // factories are still registered before the throw — priming inside
    // ensureChatBundle handles the cyclic-dep rewire that makes them
    // callable through register.ts getters.
  }

  // 4. Boot the chat-bundle messaging WASM (12 MB
  //    `e4fa90570c4c2d9e59c1.wasm` via webpack module 86818). This
  //    registers ~74 Embind classes on the moduleEnv —
  //    `messaging_Session`, `messaging_StatelessSession`,
  //    `messaging_IdentityDelegate`, `messaging_RecipientProvider`,
  //    `e2ee_E2EEKeyManager`, etc. See `../bundle/chat-wasm-boot.ts`.
  //
  //    Hypothesis (per chat-wasm-boot.ts file comment): once the WASM is
  //    up + Embind classes are registered, Snap's own bundle code drives
  //    Fidelius identity generation and messaging session bring-up
  //    automatically. We're testing whether wiring this single call as
  //    the final bring-up step is enough to light up E2E messaging.
  //
  //    Failure here is non-fatal: auth itself doesn't depend on the
  //    WASM, only message decryption / Fidelius does. Friends, search,
  //    add-friend, etc. all function without it — log and continue so a
  //    WASM regression doesn't break the rest of the SDK.
  try {
    const { moduleEnv } = await bootChatWasm(ctx.sandbox);

    // After WASM boots, inject a Comlink-worker-shaped facade into
    // `state.wasm.workerProxy` so the bundle's own
    // `messaging.initializeClient` finds something to call. The bundle
    // normally constructs this by Comlink-wrapping a real Web Worker;
    // we don't have one (vm.Context can't host workers), so the facade
    // forwards `createMessagingSession(...18 args)` straight to the
    // directly-booted Embind class. See `bundle/worker-proxy-facade.ts`.
    try {
      const facade = makeWorkerProxyFacade(moduleEnv);
      const store = chatStore(ctx.sandbox);
      // ChatState in bundle/types.ts only declares `auth` + `user`; the
      // live store also carries `wasm` + `messaging` slices we're
      // extending here. Cast the updater through `unknown` so the
      // partial we return can include extra keys without leaking
      // bundle-private slice types into the public type surface.
      const setStateAny = store.setState as unknown as (
        updater: (s: Record<string, unknown>) => Record<string, unknown>,
      ) => void;
      setStateAny((s) => {
        const prevWasm = (s?.wasm ?? {}) as Record<string, unknown>;
        return {
          wasm: {
            ...prevWasm,
            module: { ref: moduleEnv },
            worker: null,
            workerProxy: facade,
          },
        };
      });

      // NOTE: do NOT call messaging.initializeClient here — it requires
      // state.auth.userId to be populated, which only happens after
      // `auth.initialize` runs (later in `authenticate()`). The deferred
      // call lives in `kickoffMessagingSession()`, invoked after
      // mintAndInitialize / fullLogin lands a userId.
    } catch (err) {
      console.warn(
        "[snapcap] workerProxy facade injection failed:",
        (err as Error).message,
      );
    }
  } catch (err) {
    console.warn(
      "[snapcap] chat WASM boot failed; messaging features unavailable:",
      (err as Error).message,
    );
  }

  ctx._bundlesLoaded = true;
}
