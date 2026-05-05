/**
 * Presence duplex bridge — adapts the standalone-realm `En` engine's
 * `registerDuplexHandler` into the duplex-client shape the chat-bundle's
 * `state.presence.initializePresenceServiceTs(duplexClient)` expects.
 *
 * # Why this exists
 *
 * The chat bundle's React `rt()` hook (chat main byte ~577200) builds a
 * duplex client by reading `state.wasm.workerProxy.registerDuplexHandler`
 * (which Comlink-wraps a real Web Worker) and forwarding each "pcs"
 * channel registration through it. That wrapped client is what gets
 * handed to `state.presence.initializePresenceServiceTs(...)`, which
 * constructs `PresenceServiceImpl` (chat main byte ~4659400, module
 * 48712 export `t.nv`) and `Cn` (the `PresenceMessageTransport`).
 *
 * We don't run React, and we don't have a Comlink-wrapped Web Worker —
 * the WASM messaging worker chunk runs directly in our standalone vm
 * realm and exposes the same engine via `globalThis.__SNAPCAP_EN`. We
 * therefore bypass `state.wasm.workerProxy` entirely and synthesize the
 * duplex client directly from `En.registerDuplexHandler`.
 *
 * # Cross-realm hand-off
 *
 * `state.presence.*` lives in the **chat realm** (sandbox.context); `En`
 * lives in the **standalone realm** (the per-Sandbox cached vm.Context
 * owned by `getStandaloneChatRealm`). The duplex client object built
 * here is a plain object whose method properties are closures captured
 * at construction time — those closures reach `En` directly. Plain
 * objects cross realm boundaries safely; the bundle's `Cn` constructor
 * (chat realm) can call `.registerHandler(channel, {onReceive}, tag)` on
 * our bridge and the call lands inside the closure which forwards to
 * `En.registerDuplexHandler` (standalone realm).
 *
 * # Callback shape
 *
 * The bundle's `Cn` calls:
 *   - `registerHandler("pcs", {onReceive: bytes => void}, tag)` — bytes are a
 *     Uint8Array (sandbox-realm). We forward to `En.registerDuplexHandler`
 *     and re-fire the inner `onReceive` with whatever bytes it produces;
 *     the chat-realm caller receives them as a Uint8Array (sandbox-realm).
 *   - `unregisterHandler("pcs", tag)` — drop the channel registration.
 *   - `addStreamListener({onStreamStatusChanged}, tag)` — subscribed to
 *     duplex connection state. We immediately fire `READY` (= number 1
 *     per the bundle's enum, but more robustly we mirror `dn.KN.READY`
 *     by passing 1 — `Cn` only uses this to flip a BehaviorSubject's
 *     boolean, and the slice's later `presence_create_session_attempt`
 *     metric is the only consumer; functional impact is zero either way).
 *   - `send(channel, bytes, callbacks?, tag?)` — outbound presence frame.
 *     We forward to the cached `En.registerDuplexHandler` handle's
 *     `.send(channel, bytes)` and fire `callbacks?.onSend()` synchronously
 *     so the bundle treats the dispatch as completed.
 *   - `appStateChanged`, `dispose`, `disposeAsync`,
 *     `appMemoryPressureStateChanged`, `callParticipationChanged` — no-ops,
 *     same as the React wrapper.
 *
 * # Cross-realm Uint8Array projection on inbound `pcs` frames
 *
 * The bytes the standalone-realm `En.registerDuplexHandler`'s wrapped
 * `onReceive` hands us are a STANDALONE-realm `Uint8Array` (the WASM
 * worker chunk creates them inside its own vm.Context). We forward
 * those bytes to the chat-bundle's `PresenceMessageTransport` (`Cn`)
 * which then runs them through the bundle's protobuf decoder — and that
 * decoder lives in the CHAT realm. Cross-realm `bytes instanceof
 * Uint8Array` against the chat realm's constructor fails for a
 * standalone-realm `Uint8Array`, so the decoder throws "illegal buffer."
 *
 * Fix mirrors the pattern in `src/shims/websocket.ts:30-32`: resolve
 * the chat realm's `Uint8Array` constructor once at bridge-construction
 * time (closure), then project incoming bytes via `new ChatU8(byteLen)`
 * + `.set(...)` before forwarding to the bundle's `onReceive`.
 *
 * @internal Bundle-layer plumbing. Public consumers never construct this.
 */
import vm from "node:vm";
import type { StandaloneChatRealm } from "./chat/standalone/index.ts";
import type { Sandbox } from "../shims/sandbox.ts";

/**
 * The standalone-realm `En` engine surface this bridge needs. Mirrors the
 * subset of `En`'s shape exposed by the f16f14e3 worker chunk patch.
 *
 * @internal
 */
type EnDuplexEngine = {
  registerDuplexHandler: (
    path: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
  ) => DuplexHandlerHandle | Promise<DuplexHandlerHandle>;
};

/**
 * The handle the standalone-realm `En.registerDuplexHandler` returns —
 * a `J(...)`-wrapped object with `send(channel, bytes)` and
 * `unregisterHandler()`.
 *
 * @internal
 */
type DuplexHandlerHandle = {
  send: (channel: string, bytes: Uint8Array) => void;
  unregisterHandler: () => void;
};

/**
 * Shape accepted by the chat-bundle's `state.presence.initializePresenceServiceTs`.
 * Matches the React `rt()` wrapper at chat main byte ~577200 and the
 * `PresenceMessageTransport` (`Cn`) constructor at chat main byte ~8307500.
 *
 * @internal
 */
export interface PresenceDuplexClient {
  registerHandler: (
    channel: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
    tag?: unknown,
  ) => void;
  unregisterHandler: (channel: string, tag?: unknown) => void;
  addStreamListener: (
    listener: { onStreamStatusChanged: (status: number | string | boolean) => void },
    tag?: unknown,
  ) => void;
  removeStreamListener: (listener: unknown, tag?: unknown) => void;
  send: (
    channel: string,
    bytes: Uint8Array,
    callbacks?: { onSend?: () => void; onError?: (status: unknown) => void },
    tag?: unknown,
  ) => void;
  appStateChanged: (..._a: unknown[]) => void;
  dispose: (..._a: unknown[]) => void;
  disposeAsync: (..._a: unknown[]) => void;
  appMemoryPressureStateChanged: (..._a: unknown[]) => void;
  callParticipationChanged: (..._a: unknown[]) => void;
}

/**
 * Build a duplex-client bridge for the chat-bundle's presence layer.
 *
 * The returned object is a plain JS object; its methods close over the
 * standalone-realm `En` engine reference and forward to it. No
 * module-scope state — every call to this factory yields a fresh bridge.
 *
 * @internal
 * @param realm - the per-Sandbox standalone chat realm (vm.Context +
 *   moduleEnv); `globalThis.__SNAPCAP_EN` must be exposed inside it
 *   (set by `setupBundleSession`'s f16f14e3 chunk patch).
 * @param sandbox - the per-instance chat-bundle {@link Sandbox} whose
 *   realm hosts the bundle's protobuf decoder. Used to resolve the
 *   chat-realm `Uint8Array` constructor once at bridge-construction
 *   time so inbound `pcs` bytes (which arrive as a STANDALONE-realm
 *   `Uint8Array`) can be projected into the chat realm before being
 *   forwarded to the bundle's `onReceive` — see "Cross-realm Uint8Array
 *   projection" in the file header.
 * @param log - optional diagnostic sink. Defaults to no-op.
 * @returns a {@link PresenceDuplexClient} ready to be handed to
 *   `state.presence.initializePresenceServiceTs(...)`.
 * @throws when the standalone realm doesn't have `__SNAPCAP_EN` exposed
 *   (the worker chunk hasn't been patched / eval'd yet).
 */
export function createPresenceBridge(
  realm: StandaloneChatRealm,
  sandbox: Sandbox,
  log: (line: string) => void = () => {},
): PresenceDuplexClient {
  // Reach the standalone-realm `En`. The chunk patch in
  // `bundle/chat/standalone/session/chunk-patch.ts` exposes it as `globalThis.__SNAPCAP_EN`
  // inside `realm.context` — read it via vm.runInContext so we get the
  // realm-local reference (cross-realm property reads work but make
  // intent explicit).
  const realmGlobal = vm.runInContext("globalThis", realm.context) as Record<string, unknown>;
  const En = realmGlobal.__SNAPCAP_EN as EnDuplexEngine | undefined;
  if (!En || typeof En.registerDuplexHandler !== "function") {
    throw new Error(
      "createPresenceBridge: standalone realm has no __SNAPCAP_EN.registerDuplexHandler — " +
      "setupBundleSession's chunk patch hasn't run, or the bundle shape shifted",
    );
  }

  // Resolve the CHAT realm's `Uint8Array` constructor once. Used to
  // project incoming `pcs` bytes (arriving as a STANDALONE-realm
  // `Uint8Array` from `En.registerDuplexHandler`'s callback) into the
  // chat realm so the bundle's protobuf decoder's
  // `bytes instanceof Uint8Array` check passes — without this the
  // decoder throws "illegal buffer." Mirrors the projection pattern in
  // `src/shims/websocket.ts:30-32`. Falls back to host `Uint8Array`
  // when the chat sandbox isn't initialized — that path produces a
  // cleaner downstream error than throwing here.
  const ChatU8 =
    sandbox.getGlobal<Uint8ArrayConstructor>("Uint8Array") ?? Uint8Array;

  // Per-channel handle cache. `Cn` only ever registers one channel ("pcs"),
  // but accept N channels to match the contract. Caches the result of
  // `En.registerDuplexHandler(channel, cb)` so subsequent send / unregister
  // calls use the right handle.
  //
  // This Map lives inside the closure of THIS bridge instance — it is NOT
  // module-scope state. A fresh `createPresenceBridge` call yields a fresh
  // Map. Multi-instance-safe by construction.
  const handles = new Map<string, DuplexHandlerHandle>();
  // Pending registration promises — En.registerDuplexHandler may return
  // a Promise (Comlink-wrapped on the standalone side). We resolve once
  // and replay any sends queued during the resolution window.
  const pending = new Map<string, Promise<DuplexHandlerHandle>>();

  const ensureHandle = async (
    channel: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
  ): Promise<DuplexHandlerHandle> => {
    const cached = handles.get(channel);
    if (cached) {
      process.stderr.write(`[trace.bridge.ensureHandle] CACHE-HIT channel=${channel}\n`);
      return cached;
    }
    let p = pending.get(channel);
    if (p) {
      process.stderr.write(`[trace.bridge.ensureHandle] PENDING channel=${channel}\n`);
      return p;
    }
    process.stderr.write(`[trace.bridge.ensureHandle] → En.registerDuplexHandler channel=${channel}\n`);
    // Wrap onReceive to trace inbound frames coming UP from the bundle's
    // duplex client into the presence layer. CRITICAL cross-realm
    // projection: the standalone-realm `En` hands us a STANDALONE-realm
    // `Uint8Array` here, but the bundle's protobuf decoder lives in the
    // chat realm and does `bytes instanceof Uint8Array` against the
    // chat-realm constructor. Without projection the decoder throws
    // "illegal buffer." Same trick as `src/shims/websocket.ts:30-32`.
    const wrappedHandler = {
      onReceive: (bytes: Uint8Array): void => {
        const inLen = bytes?.byteLength ?? 0;
        let projected: Uint8Array = bytes;
        try {
          if (bytes && bytes.byteLength > 0) {
            const inst = new ChatU8(bytes.byteLength);
            inst.set(bytes);
            projected = inst;
          }
        } catch (e) {
          process.stderr.write(`[trace.bridge.onReceive] projection threw=${(e as Error).message?.slice(0, 200)}\n`);
        }
        process.stderr.write(`[trace.bridge.onReceive] channel=${channel} bytes=${inLen} projected=${projected?.byteLength ?? "?"}\n`);
        try { handler.onReceive(projected); }
        catch (e) {
          process.stderr.write(`[trace.bridge.onReceive] inner threw=${(e as Error).message?.slice(0, 200)}\n`);
        }
      },
    };
    p = (async () => {
      try {
        const result = await En.registerDuplexHandler(channel, wrappedHandler);
        handles.set(channel, result);
        const handleKeys = result && typeof result === "object" ? Object.keys(result).join(",") : "?";
        const hasSend = typeof (result as { send?: unknown })?.send === "function";
        process.stderr.write(`[trace.bridge.ensureHandle] ← En.registerDuplexHandler RESOLVED channel=${channel} handle.keys=[${handleKeys}] hasSend=${hasSend}\n`);
        return result;
      } catch (e) {
        process.stderr.write(`[trace.bridge.ensureHandle] ← En.registerDuplexHandler THREW channel=${channel} err=${(e as Error).message?.slice(0, 200)}\n`);
        throw e;
      } finally {
        pending.delete(channel);
      }
    })();
    pending.set(channel, p);
    return p;
  };

  const bridge: PresenceDuplexClient = {
    registerHandler(channel, handler, _tag) {
      process.stderr.write(`[trace.bridge.registerHandler] channel=${channel} tag=${String(_tag).slice(0, 40)}\n`);
      // Fire-and-forget; the standalone-side handler registration is
      // synchronous from the WASM's perspective (the JavaScript handler
      // gets stored on the `un.duplexClient` immediately). We surface
      // any exception via `log` so it shows up in our diagnostic stream
      // rather than disappearing into a dropped Promise.
      ensureHandle(channel, handler).catch((e) => {
        log(`[presence-bridge.registerHandler] channel=${channel} threw: ${(e as Error).message?.slice(0, 200)}`);
      });
    },

    unregisterHandler(channel, _tag) {
      process.stderr.write(`[trace.bridge.unregisterHandler] channel=${channel}\n`);
      const h = handles.get(channel);
      handles.delete(channel);
      if (h) {
        try { h.unregisterHandler(); }
        catch (e) {
          log(`[presence-bridge.unregisterHandler] channel=${channel} threw: ${(e as Error).message?.slice(0, 200)}`);
        }
      }
    },

    addStreamListener(listener, _tag) {
      process.stderr.write(`[trace.bridge.addStreamListener] firing READY=1 sync\n`);
      // The standalone realm's WS is already up by the time this bridge
      // is constructed (setupBundleSession waited on it). Fire READY=1
      // synchronously so `Cn`'s `isConnectedObservable` flips to `true`
      // and `PresenceServiceImpl` proceeds to broadcast presence updates.
      // Real status changes don't propagate (we're stateless here) — but
      // the WS lifecycle in the standalone realm is process-lifetime so
      // this matches reality.
      try { listener.onStreamStatusChanged(1); }
      catch (e) {
        log(`[presence-bridge.addStreamListener] listener threw: ${(e as Error).message?.slice(0, 200)}`);
      }
    },

    removeStreamListener(_listener, _tag) {
      process.stderr.write(`[trace.bridge.removeStreamListener]\n`);
      // No-op — same as the React wrapper.
    },

    send(channel, bytes, callbacks, _tag) {
      // The bundle's `Cn` registers a handler under channel `pcs` (the
      // `x8` constant in module 15648), but `Cn.sendMessage` later calls
      // `duplexWrapper.sendMessage("http://pcs.snap/send-transient-message",
      // bytes)` (the `SK` constant). Same channel ROOT, different
      // wire-format strings — registration is by short tag, send is by
      // full method URL. The standalone-realm `En.registerDuplexHandler`
      // returns ONE handle whose `.send(channel, bytes)` accepts the full
      // URL channel (the engine routes both reads and writes through the
      // same Gateway WS).
      //
      // Lookup strategy: exact match first (handles future channels with
      // different roots), then fall back to "any registered handle" since
      // only one duplex registration exists in practice (`pcs` from `Cn`).
      // Without the fallback, every typing-pulse send sees an
      // UNAVAILABLE result and the WASM never produces a wire frame.
      let h = handles.get(channel);
      let lookupBy: string = h ? channel : "";
      if (!h && handles.size > 0) {
        const first = handles.entries().next().value;
        if (first) {
          h = first[1];
          lookupBy = `fallback-via-${first[0]}`;
        }
      }
      const cbKeys = callbacks ? Object.keys(callbacks).join(",") : "none";
      process.stderr.write(`[trace.bridge.send] channel=${channel} bytes=${bytes?.byteLength ?? "?"} lookup=${lookupBy || "miss"} callbacks=[${cbKeys}]\n`);
      if (!h) {
        // Shouldn't happen in practice — the bundle calls registerHandler
        // before send. If it does, surface via the error callback.
        try { callbacks?.onError?.("UNAVAILABLE"); }
        catch { /* tolerate */ }
        log(`[presence-bridge.send] channel=${channel} no handle yet`);
        process.stderr.write(`[trace.bridge.send] EXIT-NO-HANDLE channel=${channel}\n`);
        return;
      }
      try {
        process.stderr.write(`[trace.bridge.send] → handle.send(channel, bytes) channel=${channel}\n`);
        h.send(channel, bytes);
        process.stderr.write(`[trace.bridge.send] ← handle.send returned channel=${channel}\n`);
        try { callbacks?.onSend?.(); }
        catch { /* tolerate */ }
      } catch (e) {
        process.stderr.write(`[trace.bridge.send] ← handle.send THREW channel=${channel} err=${(e as Error).message?.slice(0, 200)}\n`);
        log(`[presence-bridge.send] channel=${channel} threw: ${(e as Error).message?.slice(0, 200)}`);
        try { callbacks?.onError?.((e as Error).message ?? "UNKNOWN"); }
        catch { /* tolerate */ }
      }
    },

    appStateChanged(...args) {
      process.stderr.write(`[trace.bridge.appStateChanged] args=${args.length}\n`);
    },
    dispose() {
      process.stderr.write(`[trace.bridge.dispose]\n`);
    },
    disposeAsync() {
      process.stderr.write(`[trace.bridge.disposeAsync]\n`);
    },
    appMemoryPressureStateChanged() { /* no-op */ },
    callParticipationChanged() { /* no-op */ },
  };

  return bridge;
}
