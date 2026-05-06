/**
 * Inbound message decrypt — bundle-driven session bring-up.
 *
 * Brings up Snap's own messaging session inside the same `vm.Context`
 * that hosts the standalone chat WASM (booted by `../realm.ts`),
 * patches the f16f14e3 worker chunk to expose its `En` engine + `un`
 * env, then calls `En.createMessagingSession(...)`. The chunk's own
 * duplex client opens the WS to `aws.duplex.snapchat.com`, subscribes
 * to the inbound stream; messages flow → WASM decrypts → the wrapped
 * `messagingDelegate.onMessageReceived(t)` fires with `t.content` as
 * plaintext bytes.
 *
 * Mechanism summary:
 *
 *   1. Reuse the cached realm from `getStandaloneChatRealm()` — Module
 *      is already up with all 74 Embind classes registered.
 *   2. Project a Node-`ws`-backed `WebSocket` shim + `importScripts`
 *      stub onto the realm's globalThis. Pre-bind cookies for the WS
 *      upgrade GET (the duplex client can't await in its constructor).
 *   3. Source-patch `f16f14e3b729db223348.chunk.js` to expose `En` /
 *      `un` / `pn` on globalThis BEFORE its `z(En)` Comlink call. Eval
 *      the patched chunk in the realm.
 *   4. Inject our pre-built Module into `un.wasmModule` via `pn`. Init
 *      Platform / ConfigRegistry / GrpcManager (the WASM-side services
 *      the chunk would normally init from a worker bootstrap). Wire
 *      GrpcManager's web factory through native fetch + cookie jar so
 *      Fidelius gateway calls pass under the SDK's auth.
 *   5. Wrap `Module.messaging_Session.create` arg slot 9 (the
 *      messagingDelegate) so `onMessageReceived` / `onMessagesReceived`
 *      forward `t.content` to the caller's `onPlaintext`.
 *   6. Call `En.setAuthTokenGetter(() => bearer)`,
 *      `En.setMcsCofSequenceIdsGetter(() => [])`, then
 *      `En.createMessagingSession(...18 args)`. Pulse `reachabilityChanged(true)`
 *      + `appStateChanged(ACTIVE)` to wake the session.
 *   7. Pump the inbox: `enterConversation(...)` +
 *      `fetchConversationWithMessages(...)` per conv → WASM decrypts
 *      cached messages → wrapped delegate fires.
 *
 * @internal Auth-layer; called from `api/messaging/bringup.ts`.
 */
import { join } from "node:path";
import vm from "node:vm";
import { installSessionRealmGlobals, installSessionRealmFetch } from "./realm-globals.ts";
import { createWebSocketShim } from "./ws-shim.ts";
import { makeJarFetch } from "../../../../transport/cookies.ts";
import { installImportScripts } from "./import-scripts.ts";
import { loadPatchedChunk } from "./chunk-patch.ts";
import { instrumentRegisterDuplexHandler } from "./register-duplex-trace.ts";
import { wrapSessionCreate } from "./wrap-session-create.ts";
import { createPushHandler } from "./push-handler.ts";
import { initWasmServices } from "./wasm-services-init.ts";
import { registerGrpcWebFactory } from "./grpc-web-factory.ts";
import { buildSessionArgs } from "./session-args.ts";
import { wakeSession } from "./wake-session.ts";
import { pumpInbox } from "./inbox-pump.ts";
import type {
  BundleMessagingSession,
  BundleSessionDisposer,
  EmModule,
  SetupBundleSessionOpts,
} from "./types.ts";

type EnEngine = {
  setAuthTokenGetter: (g: () => Promise<string> | string) => void;
  setMcsCofSequenceIdsGetter: (g: () => Promise<unknown[]> | unknown[]) => void;
  createMessagingSession: (...a: unknown[]) => Promise<Record<string, Function>>;
  onNetworkStatusChange?: (status: string) => void;
  registerDuplexHandler?: (
    path: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
  ) => unknown;
};

/**
 * Boot Snap's messaging session inside the standalone-WASM mint realm
 * and stream decrypted inbound messages to `opts.onPlaintext`.
 *
 * @param opts - Session setup parameters; see {@link SetupBundleSessionOpts}.
 * @returns A disposer (currently a no-op — the bundle session is
 *   process-lifetime).
 *
 * @throws If the f16f14e3 chunk patch site has shifted (Snap rebuilt
 *   the bundle), if `En.createMessagingSession` rejects, or if the WS
 *   upgrade fails inside the chunk's duplex client.
 */
export async function setupBundleSession(
  opts: SetupBundleSessionOpts,
): Promise<BundleSessionDisposer> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const bundleDir =
    opts.bundleDir ?? join(import.meta.dirname, "..", "..", "..", "..", "..", "vendor", "snap-bundle");
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");
  const chunkPath = join(chatDw, "f16f14e3b729db223348.chunk.js");
  const chunk7818Path = join(chatDw, "06c27f3bcaa1e5c47eea.chunk.js");

  const { moduleEnv, context, wreq } = opts.realm;
  void wreq;
  const Module = moduleEnv as unknown as EmModule;
  if (!Module || typeof Module._malloc !== "function") {
    throw new Error("setupBundleSession: moduleEnv missing _malloc — WASM not booted");
  }
  if (typeof (Module as Record<string, unknown>).messaging_Session !== "function") {
    throw new Error(
      "setupBundleSession: moduleEnv.messaging_Session not registered — Embind shape may have shifted",
    );
  }
  // Cross-realm constructors so cross-realm `instanceof` checks pass
  // inside the chunk and the WASM Embind layer.
  const VmU8 = vm.runInContext("Uint8Array", context) as Uint8ArrayConstructor;
  const VmMap = vm.runInContext("Map", context) as MapConstructor;

  // ── Top up the realm with the slots the chunk + its dep graph need ─
  const realmGlobal = vm.runInContext("globalThis", context) as Record<string, unknown>;
  installSessionRealmGlobals(realmGlobal);

  // ── Cookie-attached fetch for media uploads (Fi.uploadMedia → CDN) ─
  // The mint-realm boot stubs `fetch` to throw "unavailable in mint realm".
  // The session realm reuses that boot, so override here with a real
  // fetch that threads cookies through the same jar the WebSocket shim
  // uses below. Without this, the bundle's image-send pipeline hangs
  // after `Image` dimensions are read — Fi.uploadMedia silently catches
  // the "fetch unavailable" throw and waits for an upload that never starts.
  const baseRealmFetch = makeJarFetch(opts.cookieJar, opts.userAgent);
  const realmFetch = process.env.SNAPCAP_DEBUG_REALM_FETCH === "1"
    ? async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const t0 = Date.now();
        process.stderr.write(`[realm.fetch] → ${method} ${url}\n`);
        try {
          const res = await baseRealmFetch(url, init);
          process.stderr.write(`[realm.fetch] ← ${method} ${url} ${res.status} ${Date.now() - t0}ms\n`);
          return res;
        } catch (err) {
          process.stderr.write(`[realm.fetch] ✗ ${method} ${url} ${(err as Error).message}\n`);
          throw err;
        }
      }
    : baseRealmFetch;
  installSessionRealmFetch(realmGlobal, realmFetch);

  // ── WebSocket shim (pre-binds cookies for the duplex upgrade) ──────
  const WebSocketShim = await createWebSocketShim({
    cookieJar: opts.cookieJar,
    userAgent: opts.userAgent,
    log,
    VmU8,
  });
  realmGlobal.WebSocket = WebSocketShim;

  // ── importScripts polyfill (load sibling chunks from disk) ─────────
  installImportScripts({
    realmGlobal,
    context,
    knownChunks: { "dw/06c27f3bcaa1e5c47eea.chunk.js": chunk7818Path },
    log,
  });

  // ── Source-patch f16f14e3: expose En + un + pn before z(En) ────────
  loadPatchedChunk({ chunkPath, context, log });
  await new Promise((r) => setTimeout(r, 200));

  const En = realmGlobal.__SNAPCAP_EN as EnEngine | undefined;
  const un = realmGlobal.__SNAPCAP_UN as Record<string, unknown> | undefined;
  const pn = realmGlobal.__SNAPCAP_PN as ((slot: string) => (val: unknown) => void) | undefined;
  if (!En) {
    throw new Error("setupBundleSession: chunk did not expose En — patch may have failed");
  }

  // [TRACE-INSTRUMENTATION] — observe every duplex registration + send.
  // Removable in one commit by deleting this call + the import.
  instrumentRegisterDuplexHandler(En);

  // ── Push handler + session-create wrap ─────────────────────────────
  const pushHandler = createPushHandler({
    onPlaintext: opts.onPlaintext,
    log,
    VmU8,
  });
  wrapSessionCreate({
    Module,
    handlePushMessage: pushHandler.handlePushMessage,
    log,
  });

  // ── Inject our pre-built Module into un.wasmModule + fatal reporter ─
  if (un && pn) {
    pn("wasmModule")(Module);
    pn("fatalErrorReporter")({
      reportFatalError: (e: unknown) =>
        log(`[wasm.fatal] ${JSON.stringify(e).slice(0, 200)}`),
    });
  } else {
    log(`[setupBundleSession] WARN un or pn missing — chunk may use its own Module`);
  }

  // ── Platform + Config + GrpcManager init ───────────────────────────
  initWasmServices({ Module, log, VmU8 });
  registerGrpcWebFactory({
    Module,
    bearer: opts.bearer,
    userAgent: opts.userAgent,
    cookieJar: opts.cookieJar,
    log,
    VmU8,
  });

  // ── Configure En and call createMessagingSession ───────────────────
  En.setAuthTokenGetter(() => Promise.resolve(opts.bearer));
  En.setMcsCofSequenceIdsGetter(() => Promise.resolve([]));

  const sessionArgs = buildSessionArgs({
    setupOpts: opts,
    VmU8,
    VmMap,
    log,
  });

  let session: BundleMessagingSession;
  try {
    const sessionPromise = En.createMessagingSession(...sessionArgs);
    session = await Promise.race([
      sessionPromise,
      new Promise<never>((_r, rej) =>
        setTimeout(() => rej(new Error("createMessagingSession timeout (15s)")), 15000),
      ),
    ]);
  } catch (e) {
    log(`[setupBundleSession] createMessagingSession FAILED: ${(e as Error).message}`);
    throw e;
  }

  // Capture the session ref for the live-push body fetch path
  // (handlePushMessage → fetchPushBody → cm.fetchMessage).
  pushHandler.setSession(session);

  // Hand the session out to the caller — `Messaging.sendText/sendImage/sendSnap`
  // hold the reference and drive `sendMessageWithContent` through it.
  if (opts.onSession) {
    try {
      opts.onSession(session);
    } catch (e) {
      log(`[setupBundleSession] onSession callback threw ${(e as Error).message?.slice(0, 200)}`);
    }
  }

  // ── Wake the session (reachability + appState + sync_trigger + online) ─
  // See wake-session.ts for the rationale of each pulse — without them
  // the WASM routes message-decrypt results to analytics only and the
  // messagingDelegate stays silent on inbound traffic.
  wakeSession({ session, En, log });

  // ── Pump the inbox: enter conversations + fetch history ────────────
  pumpInbox({
    session,
    conversationIds: opts.conversationIds ?? [],
    onPlaintext: opts.onPlaintext,
    log,
    VmU8,
  });

  return () => {
    /* no-op disposer for now */
  };
}
