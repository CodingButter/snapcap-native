/**
 * Messaging manager — inbound + outbound DM surface.
 *
 * # Two layers in one class
 *
 * 1. **Raw envelope reads** ({@link Messaging.listConversations},
 *    {@link Messaging.fetchEncryptedMessages}) — direct gRPC-Web calls to
 *    `MessagingCoreService`. Handy for inbox enumeration and historical
 *    message backfill that doesn't need decrypt.
 * 2. **Live decrypted stream + presence** ({@link Messaging.on},
 *    {@link Messaging.setTyping}, {@link Messaging.setViewing},
 *    {@link Messaging.setRead}) — boots Snap's own messaging session
 *    inside our standalone-WASM realm (`setupBundleSession` in
 *    `auth/fidelius-decrypt.ts`) and emits plaintext `message` events
 *    through a {@link TypedEventBus}.
 *
 * # Lifecycle
 *
 * The bundle session bring-up is ~3s (mints/registers Fidelius identity if
 * needed, evals `f16f14e3` chunk, opens the duplex WS). It's NOT done in
 * the `SnapcapClient` constructor — consumers that only want raw envelope
 * reads shouldn't pay that cost. First `on('message', ...)`, `setTyping`,
 * or `setViewing` triggers a single shared bring-up; subsequent calls
 * reuse the same session.
 *
 * # Raw envelope path
 *
 *   - `SyncConversations` — returns the user's conversation list.
 *   - `BatchDeltaSync` — given a set of conv IDs, returns recent encrypted
 *     message envelopes per conv.
 *
 * Both use plain gRPC-Web POST framing; auth is bearer + parent-domain
 * cookies — same pattern as `api/fidelius.ts`.
 */
import type { ClientContext } from "./_context.ts";
import { nativeFetch } from "../transport/native-fetch.ts";
import { ProtoWriter } from "../transport/proto-encode.ts";
import { uuidToBytes, bytesToUuid } from "./_helpers.ts";
import { getOrCreateJar } from "../shims/cookie-jar.ts";
import { type Subscription, TypedEventBus } from "../lib/typed-event-bus.ts";
import {
  setupBundleSession,
  type BundleMessagingSession,
  type PlaintextMessage,
} from "../auth/fidelius-decrypt.ts";
import {
  mintFideliusIdentity,
  getStandaloneChatRealm,
  type StandaloneChatRealm,
} from "../auth/fidelius-mint.ts";
import { sendMediaViaSession, createOutboundCapture } from "./_media_upload.ts";
import { createPresenceBridge } from "../bundle/presence-bridge.ts";
import type { BundlePresenceSession } from "../bundle/types/index.ts";

// ── Inline ProtoReader (no shared one in transport/) ──────────────────
class ProtoReader {
  constructor(private buf: Uint8Array, public pos = 0) {}
  next(): { field: number; wireType: number } | null {
    if (this.pos >= this.buf.byteLength) return null;
    const tag = this.varint();
    return { field: Number(tag >> 3n), wireType: Number(tag & 0x7n) };
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.byteLength) {
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    return result;
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.bytes();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 5) this.pos += 4;
  }
}

/** Per-conversation summary returned by {@link Messaging.listConversations}. */
export interface ConversationSummary {
  /** Hyphenated UUID. */
  conversationId: string;
  /** Conversation kind code from MCS — 5 = DM, 13 = group, 420 = MOB friends, etc. */
  type: number;
  /** Hyphenated UUIDs of all participants (includes self). */
  participants: string[];
}

/** One message envelope as captured from BatchDeltaSync. */
export interface RawEncryptedMessage {
  /** Conversation this message belongs to. */
  conversationId: string;
  /** Sender's hyphenated UUID. */
  senderUserId: string;
  /** Server message id (varint). */
  messageId: bigint;
  /** Server timestamp (ms since epoch). */
  serverTimestampMs: bigint;
  /**
   * Raw envelope bytes — the `f3` ContentEnvelope on the ContentMessage
   * proto. Includes the FideliusEncryption sub-message and the
   * AES-GCM-wrapped body.
   */
  envelope: Uint8Array;
  /**
   * Cleartext content if the conversation is non-E2E (AI bot replies,
   * MEMORIES, etc.) — otherwise `undefined`. Surfaced when present so
   * consumers can render a message without going through decrypt.
   */
  cleartextBody?: string;
}

/**
 * Event map for {@link Messaging.on}.
 *
 * `message` is the only event currently wired end-to-end — it fires
 * whenever the bundle's WASM produces a plaintext message via the
 * messaging delegate. The presence events (`typing`, `viewing`, `read`)
 * are declared so consumers can subscribe today; the inbound delegate
 * slots that drive them are still being mapped — see TODO inside
 * {@link Messaging.#bringUpSession}.
 */
export type MessagingEvents = {
  /** A decrypted plaintext message arrived. */
  message: (msg: PlaintextMessage) => void;
  /** Peer started typing in `convId` until `until` (ms epoch). */
  typing: (ev: { convId: string; userId: string; until: number }) => void;
  /** Peer is viewing `convId` until `until` (ms epoch). */
  viewing: (ev: { convId: string; userId: string; until: number }) => void;
  /** Peer marked `messageId` read at `at` (ms epoch). */
  read: (ev: { convId: string; userId: string; messageId: string; at: number }) => void;
};

/**
 * Messaging manager — inbox enumeration + live decrypt + presence.
 *
 * @see {@link SnapcapClient.messaging}
 */
export class Messaging {
  /**
   * Per-instance event bus. Bridge code inside {@link Messaging.#bringUpSession}
   * calls `this.#events.emit("message", ...)`; consumers subscribe via
   * {@link Messaging.on}.
   */
  readonly #events = new TypedEventBus<MessagingEvents>();

  /**
   * Lazy bring-up handle. Resolved once the standalone-chat realm is up
   * and `setupBundleSession` has wired the messaging delegate. `undefined`
   * before the first event subscription / presence call.
   */
  #sessionPromise?: Promise<void>;

  /**
   * Bundle-realm messaging session captured during `#bringUpSession` —
   * the result of `En.createMessagingSession(...)`. `sendText` /
   * `sendImage` / `sendSnap` drive `sendMessageWithContent` through it.
   *
   * @internal
   */
  #session?: BundleMessagingSession;

  /**
   * Standalone-chat realm captured during `#bringUpSession`. Holds the
   * webpack `wreq` we use to reach the bundle's send entries (module
   * 56639 — `pn` / `E$` / `HM`).
   *
   * @internal
   */
  #realm?: StandaloneChatRealm;

  /**
   * Once-per-Messaging-instance flag — set to `true` after the first
   * successful `state.presence.initializePresenceServiceTs(bridge)` call.
   * Subsequent typing/viewing calls skip the init.
   *
   * Lives as a `#` private instance field — NOT module scope. Each
   * `Messaging` instance (= each `SnapcapClient`) tracks its own init
   * state independently; multi-instance-safe by construction.
   *
   * @internal
   */
  #presenceInitialized = false;

  /**
   * Per-conv `BundlePresenceSession` cache. The bundle's
   * `state.presence.presenceSession` slot is single-instance
   * (one-active-session-globally), so creating a session for conv B
   * disposes the one for conv A. We still cache by convId so
   * back-to-back calls on the same conv reuse the live session.
   *
   * Lives as a `#` private instance field, keyed by per-instance convId
   * strings — NOT module scope. Each `Messaging` instance owns its own
   * Map; multi-instance-safe by construction.
   *
   * @internal
   */
  readonly #presenceSessions = new Map<string, BundlePresenceSession>();

  /** @internal */
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}

  // ── Live event subscription ─────────────────────────────────────────

  /**
   * Subscribe to a messaging event. First subscription triggers the
   * bundle session bring-up (~3s cold; subsequent subscriptions are free).
   *
   * @param event - One of {@link MessagingEvents}.
   * @param cb - Callback invoked with the event payload.
   * @param opts - Optional `signal`; aborting it unsubscribes.
   *
   * @example
   * ```ts
   * client.messaging.on("message", (msg) => {
   *   const text = new TextDecoder().decode(msg.content);
   *   console.log(`${msg.isSender ? "->" : "<-"} ${text}`);
   * });
   * ```
   */
  on<K extends keyof MessagingEvents>(
    event: K,
    cb: MessagingEvents[K],
    opts?: { signal?: AbortSignal },
  ): Subscription {
    const sub = this.#events.on(event, cb, opts);
    // Lazy: kick off bring-up on the first subscription. Best-effort —
    // failures surface via diagnostic stderr inside setupBundleSession.
    void this.#ensureSession();
    return sub;
  }

  // ── Outbound presence ──────────────────────────────────────────────

  /**
   * Show typing indicator in `convId` for `durationMs`, then auto-clear.
   *
   * Wires through the bundle's own typing helper — module 56639 export
   * `zM` (sendTypingNotification wrapper) → `convMgr.sendTypingNotification(convRef, kind, cb)`.
   * The bundle's TypingStateMachine on the **recipient** side starts a
   * ~3s idle timer on every received pulse and drops the indicator if
   * no follow-up arrives. To hold the indicator across windows longer
   * than 3s we re-pulse every 2.5s. **Auto-clear** is implicit:
   * returning from this function (or aborting / rejecting) stops the
   * pulse loop, and the recipient's idle timer takes the state to
   * "none" within ~3s — no peer ever sees a stale typing dot.
   *
   * @remarks
   * Drives **both** the legacy convMgr path (`sendTypingNotification`
   * via module 56639 export `zM`) AND the modern presence path
   * (`state.presence.initializePresenceServiceTs` + per-conv
   * `createPresenceSession` + `presenceSession.onUserAction({type:
   * "chatVisible"})` priming, then `broadcastTypingActivity`). Modern
   * Snap clients gate the typing indicator on the presence
   * `chat_visible` state — without priming, the WASM logs
   * `propagateTypingStateChange called while not in chat_visible state`
   * and recipients see nothing. Presence priming is best-effort: if
   * init fails (e.g. auth slice not ready), we fall through to the
   * convMgr-only path which still works for older peers.
   *
   * ```ts
   * await messaging.setTyping(convId, 1500);
   * await messaging.sendText(convId, "hello");
   * ```
   */
  async setTyping(convId: string, durationMs: number): Promise<void> {
    // [TRACE-INSTRUMENTATION-START] — remove with grep `\[trace\.`
    const _t0 = Date.now();
    process.stderr.write(`[trace.messaging] setTyping ENTER convId=${convId.slice(0, 8)} durationMs=${durationMs}\n`);
    // [TRACE-INSTRUMENTATION-END]
    await this.#ensureSession();
    if (!this.#session || !this.#realm) {
      process.stderr.write(`[trace.messaging] setTyping EXIT-EARLY no session/realm\n`);
      return; // best-effort if bring-up failed
    }
    const convRef = await this.#buildConvRef(convId);
    const sendsMod = this.#realm.wreq("56639") as Record<string, Function>;
    const zM = sendsMod.zM as Function | undefined;
    if (typeof zM !== "function") {
      process.stderr.write(`[trace.messaging] setTyping EXIT-EARLY zM not a function\n`);
      return; // bundle shape shifted; resolve quietly
    }

    // Prime the bundle's presence layer in addition to the convMgr path.
    // Modern Snap mobile clients ignore the convMgr typing pulse unless
    // a `ChatPresenceSession.onUserAction({type: "chatVisible"})` has
    // fired first to put the local state into `chat_visible`. Without
    // this, the WASM logs `propagateTypingStateChange called while not
    // in chat_visible state` and suppresses the propagation.
    //
    // Best-effort: if the presence init / session creation fails (auth
    // slice not ready, presence slice shape shifted, etc.), fall through
    // to the convMgr-only path which still works for older web peers
    // and cooperative recipients.
    const presenceSession = await this.#ensurePresenceForConv(convId);
    process.stderr.write(`[trace.messaging] setTyping ensurePresenceForConv result=${presenceSession ? "session-obj" : "undefined"}\n`);
    if (presenceSession) {
      // Inspect the bundle's awayState gate + presenceSession identity at
      // broadcast time — confirms `chatVisible` priming actually flips the
      // slice's `awayState` to Present.
      try {
        const ctx = await this._getCtx();
        const { presenceSlice } = await import("../bundle/register.ts");
        const slice = presenceSlice(ctx.sandbox) as Record<string, unknown>;
        process.stderr.write(`[trace.messaging] setTyping pre-chatVisible awayState=${String(slice.awayState)} slot-equals-cached=${slice.presenceSession === presenceSession}\n`);
      } catch (e) {
        process.stderr.write(`[trace.messaging] setTyping pre-chatVisible probe-threw=${(e as Error).message?.slice(0, 120)}\n`);
      }
      process.stderr.write(`[trace.messaging] setTyping → onUserAction(chatVisible+typing-active)\n`);
      try {
        presenceSession.onUserAction({
          type: "chatVisible",
          typingState: { state: "active" },
        });
        process.stderr.write(`[trace.messaging] setTyping ← onUserAction(chatVisible) ok\n`);
      } catch (e) {
        process.stderr.write(`[trace.messaging] setTyping ← onUserAction(chatVisible) THREW=${(e as Error).message?.slice(0, 200)}\n`);
      }
      try {
        const ctx = await this._getCtx();
        const { presenceSlice } = await import("../bundle/register.ts");
        const slice = presenceSlice(ctx.sandbox) as Record<string, unknown>;
        process.stderr.write(`[trace.messaging] setTyping post-chatVisible awayState=${String(slice.awayState)}\n`);
      } catch { /* tolerate */ }
    }

    try {
      // Drive the convMgr typing pulse loop (existing path — leaves a
      // sendTypingNotification frame on the wire every ~2.5s). Combined
      // with the presence priming above, this satisfies BOTH the legacy
      // and modern recipient code paths.
      process.stderr.write(`[trace.messaging] setTyping → zM(session, convRef) (convMgr.sendTypingNotification)\n`);
      this.#fireBundleCall(() => zM(this.#session, convRef));

      // Also broadcast via the presence slice's own `broadcastTypingActivity`
      // action when a session is live — the slice gates this on the same
      // `awayState === Present` check our `document.hasFocus = () => true`
      // chat-loader patch satisfies. The slice action signature mirrors
      // {@link PresenceSlice.broadcastTypingActivity}: takes the envelope
      // already stored on `presenceSession.conversationId`. Best-effort.
      if (presenceSession) {
        try {
          const ctx = await this._getCtx();
          const { presenceSlice } = await import("../bundle/register.ts");
          const envelope = presenceSession.conversationId as { id?: unknown; str?: string } | string | undefined;
          const envShape = envelope && typeof envelope === "object"
            ? `{id-bytelen=${(envelope.id as Uint8Array | undefined)?.byteLength}, str=${envelope.str?.slice(0, 8)}}`
            : `bare-string=${String(envelope).slice(0, 8)}`;
          process.stderr.write(`[trace.messaging] setTyping → broadcastTypingActivity envelope=${envShape}\n`);
          const r = presenceSlice(ctx.sandbox).broadcastTypingActivity(
            presenceSession.conversationId,
            "typing",
          );
          process.stderr.write(`[trace.messaging] setTyping ← broadcastTypingActivity returned=${typeof r} (${String(r).slice(0, 80)})\n`);
        } catch (e) {
          process.stderr.write(`[trace.messaging] setTyping ← broadcastTypingActivity THREW=${(e as Error).message?.slice(0, 200)}\n`);
        }
      }

      // Recipient's typing-state machine drops the indicator if no
      // valid typing frame arrives within ~3s. Pulse at 2s to give
      // ~1s of head-room. Each pulse re-fires `broadcastTypingActivity`
      // (the SAME proven action used at the initial fire above), NOT
      // the malformed `onUserAction({type:"chatVisible", typingState})`
      // shape that the bundle silently drops.
      const interval = 2000;
      const start = Date.now();
      const ctx = await this._getCtx();
      const { presenceSlice } = await import("../bundle/register.ts");
      while (Date.now() - start < durationMs) {
        const remaining = durationMs - (Date.now() - start);
        await new Promise<void>((r) => setTimeout(r, Math.min(interval, remaining)));
        if (Date.now() - start < durationMs) {
          this.#fireBundleCall(() => zM(this.#session, convRef));
          if (presenceSession) {
            try {
              presenceSlice(ctx.sandbox).broadcastTypingActivity(
                presenceSession.conversationId,
                "typing",
              );
            } catch { /* tolerate */ }
          }
        }
      }
    } finally {
      // Auto-clear: stopping the convMgr pulse loop above lets the
      // recipient's TypingStateMachine drop within ~3s. Additionally
      // fire `chatHidden` on the presence session so modern clients
      // clear the dot immediately rather than waiting for the timer.
      if (presenceSession) {
        process.stderr.write(`[trace.messaging] setTyping FINALLY → onUserAction(chatHidden)\n`);
        try {
          presenceSession.onUserAction({ type: "chatHidden" });
          process.stderr.write(`[trace.messaging] setTyping FINALLY ← onUserAction(chatHidden) ok\n`);
        } catch (e) {
          process.stderr.write(`[trace.messaging] setTyping FINALLY ← onUserAction(chatHidden) THREW=${(e as Error).message?.slice(0, 200)}\n`);
        }
      }
      process.stderr.write(`[trace.messaging] setTyping EXIT durMs=${Date.now() - _t0}\n`);
    }
  }

  /**
   * Mark `convId` as actively viewed (chat-open / focused) for `durationMs`,
   * then auto-clear with an `exitConversation` pulse.
   *
   * Wires through module 56639 export `Mw` (enterConversation) →
   * `convMgr.enterConversation(convRef, source, cb)`. Snap propagates the
   * "active in chat" state to the peer's UI as the viewing indicator;
   * pairing it with `ON` (exitConversation) on teardown clears the state.
   * `try/finally` guarantees exit fires even on abort.
   *
   * @remarks Same dual-path treatment as {@link Messaging.setTyping}:
   * primes `state.presence.presenceSession.onUserAction({type:
   * "chatVisible"})` so modern recipients honor the convMgr
   * `enterConversation` frame, and fires `chatHidden` on teardown so
   * the indicator clears immediately rather than waiting on the
   * recipient's idle timer.
   */
  async setViewing(convId: string, durationMs: number): Promise<void> {
    const _t0 = Date.now();
    process.stderr.write(`[trace.messaging] setViewing ENTER convId=${convId.slice(0, 8)} durationMs=${durationMs}\n`);
    await this.#ensureSession();
    if (!this.#session || !this.#realm) {
      process.stderr.write(`[trace.messaging] setViewing EXIT-EARLY no session/realm\n`);
      return;
    }
    const convRef = await this.#buildConvRef(convId);
    const sendsMod = this.#realm.wreq("56639") as Record<string, Function>;
    const Mw = sendsMod.Mw as Function | undefined;
    const ON = sendsMod.ON as Function | undefined;
    if (typeof Mw !== "function") return;

    // Same gate-priming as setTyping — modern Snap recipients ignore
    // the convMgr enterConversation frame unless `chatVisible` has been
    // sent on the presence session first. Best-effort.
    const presenceSession = await this.#ensurePresenceForConv(convId);
    if (presenceSession) {
      try { presenceSession.onUserAction({ type: "chatVisible" }); }
      catch { /* tolerate */ }
    }

    try {
      // Source enum 0 = unspecified; bundle accepts and the WASM doesn't
      // care for presence-frame purposes. Real React caller passes the
      // ConversationEntrySource it tracks for analytics. Fire-and-forget
      // for the same reason as setTyping — the WS frame goes out before
      // the convMgr callback fires.
      this.#fireBundleCall(() => Mw(this.#session, convRef, 0));
      await new Promise<void>((r) => setTimeout(r, durationMs));
    } finally {
      // Auto-clear: explicit exitConversation cancels the viewing state
      // immediately. Runs on every code path (await complete, abort, throw)
      // so the peer's "viewing" UI never sticks. Fire-and-forget.
      if (typeof ON === "function") {
        this.#fireBundleCall(() => ON(this.#session, convRef, 0));
      }
      if (presenceSession) {
        try { presenceSession.onUserAction({ type: "chatHidden" }); }
        catch { /* tolerate */ }
      }
      process.stderr.write(`[trace.messaging] setViewing EXIT durMs=${Date.now() - _t0}\n`);
    }
  }

  /**
   * Mark `messageId` in `convId` as read (fires a read-receipt frame).
   * Resolves once the bundle has dispatched the notification.
   *
   * Wires through module 56639 export `cr` (displayedMessages wrapper) →
   * `convMgr.displayedMessages(convRef, messageIds, cb)`. The bundle's
   * WASM batches the IDs and pushes the read state over the duplex so the
   * sender's UI flips to "Opened" / removes the unread badge.
   *
   * @param convId - Hyphenated conversation UUID.
   * @param messageId - Server message id (bigint) or its decimal-string
   *   form. From a `RawEncryptedMessage`, this is the `messageId: bigint`
   *   field; from a live inbound `message` event, the underlying delegate
   *   record carries it as well.
   */
  async setRead(convId: string, messageId: string | bigint): Promise<void> {
    await this.#ensureSession();
    if (!this.#session || !this.#realm) return;
    const convRef = await this.#buildConvRef(convId);
    const sendsMod = this.#realm.wreq("56639") as Record<string, Function>;
    const cr = sendsMod.cr as Function | undefined;
    if (typeof cr !== "function") return;
    // The Embind boundary expects a JS array of int64-coercible values
    // (BigInt). Coerce string → BigInt once so callers can pass either.
    const idBig = typeof messageId === "bigint" ? messageId : BigInt(messageId);
    // Fire-and-forget: the read-receipt WS frame leaves synchronously
    // when convMgr.displayedMessages dispatches. We don't gate caller
    // progress on the bundle's success-callback ack which doesn't always
    // fire (same pattern as sendText for bot convs).
    this.#fireBundleCall(() => cr(this.#session, convRef, [idBig]));
  }

  /**
   * @internal — invoke a bundle call (which returns a Promise that may
   * never resolve for some conv kinds), swallowing all sync throws and
   * async rejections. Fire-and-forget: the WS frame leaves synchronously
   * inside the WASM before the JS-side callback would resolve.
   */
  #fireBundleCall(fn: () => unknown): void {
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).then(
          () => {},
          () => {},
        );
      }
    } catch { /* tolerate */ }
  }

  /**
   * @internal — build a realm-local convRef ({id: vm-realm Uint8Array, str})
   * matching the shape the bundle's helpers in module 56639 expect. Mirrors
   * the inline construction inside {@link Messaging.sendText}.
   */
  async #buildConvRef(convId: string): Promise<{ id: Uint8Array; str: string }> {
    const VmU8 = await import("node:vm").then(
      (vm) => vm.runInContext("Uint8Array", this.#realm!.context) as Uint8ArrayConstructor,
    );
    const idBytes = new VmU8(16);
    idBytes.set(uuidToBytes(convId));
    return { id: idBytes, str: convId };
  }

  /**
   * @internal — ensure the bundle's presence layer has a live
   * `presenceSession` for `convId`. Lazily initializes
   * `state.presence.initializePresenceServiceTs(bridge)` on first call,
   * then creates (or reuses) a per-conv presence session.
   *
   * The bundle's `state.presence.presenceSession` is single-slot, so a
   * `createPresenceSession(B)` after a `createPresenceSession(A)` will
   * dispose A's session and replace it. Our cache is correct only as
   * long as we don't interleave convs; the cache check + state read
   * below verifies the slot still matches our cached session before
   * returning it.
   *
   * Returns `undefined` when the realm / session bring-up hasn't
   * happened yet (caller should fall back to convMgr-only path) — same
   * defensive posture as the existing setTyping / setViewing methods.
   */
  async #ensurePresenceForConv(convId: string): Promise<BundlePresenceSession | undefined> {
    process.stderr.write(`[trace.presence] ensurePresenceForConv ENTER convId=${convId.slice(0, 8)} presenceInitialized=${this.#presenceInitialized}\n`);
    if (!this.#realm) {
      process.stderr.write(`[trace.presence] ensurePresenceForConv EXIT no realm\n`);
      return undefined;
    }
    const ctx = await this._getCtx();
    const sandbox = ctx.sandbox;
    const { presenceSlice } = await import("../bundle/register.ts");

    // First-call init. Wrapped in its own try so a failure here doesn't
    // permanently block the cache — a future call retries.
    if (!this.#presenceInitialized) {
      try {
        process.stderr.write(`[trace.presence] ensurePresenceForConv → initializePresenceServiceTs(bridge)\n`);
        const slice = presenceSlice(sandbox);
        const bridge = createPresenceBridge(this.#realm, sandbox, (line) => {
          // Always echo presence-bridge log lines under our trace tag so
          // we don't have to set SNAPCAP_DEBUG_PRESENCE for the run.
          process.stderr.write(`[trace.bridge.log] ${line}\n`);
        });
        slice.initializePresenceServiceTs(bridge);
        this.#presenceInitialized = true;
        process.stderr.write(`[trace.presence] ensurePresenceForConv ← initializePresenceServiceTs ok\n`);
      } catch (e) {
        process.stderr.write(`[trace.presence] ensurePresenceForConv ← initializePresenceServiceTs THREW=${(e as Error).message?.slice(0, 200)}\n`);
        // Surface the bundle's exact error for diagnostic clarity (e.g.
        // "Local user ID is not set" if auth slice hasn't populated).
        if (process.env.SNAPCAP_DEBUG_PRESENCE) {
          process.stderr.write(
            `[messaging.#ensurePresenceForConv] initializePresenceServiceTs threw: ${
              (e as Error).message?.slice(0, 200)
            }\n`,
          );
        }
        return undefined;
      }
    }

    // Cache hit — verify the bundle still has our session in its slot.
    const cached = this.#presenceSessions.get(convId);
    if (cached) {
      try {
        const slice = presenceSlice(sandbox);
        if (slice.presenceSession === cached) {
          process.stderr.write(`[trace.presence] ensurePresenceForConv CACHE-HIT slot-still-matches\n`);
          return cached;
        }
      } catch { /* fall through to recreate */ }
      // Stale (replaced by a different conv's session, or disposed) —
      // drop and recreate below.
      process.stderr.write(`[trace.presence] ensurePresenceForConv CACHE-STALE recreating\n`);
      this.#presenceSessions.delete(convId);
    }

    // Create fresh session. The slice action returns a cleanup thunk we
    // intentionally discard — `presenceSession.dispose()` is the proper
    // teardown path (same end-effect, but the slot bookkeeping is what
    // we actually want when switching convs).
    //
    // The slice expects an envelope `{id: Uint8Array(16), str: convIdStr}`
    // (NOT a bare string) — module 74918's `s.QA(envelope)` returns the
    // `.str` field, and a bare-string input would fall through to the
    // fallback path inside `d()` and crash with `e[t+0]` because string
    // values have no `.id`. Build the envelope with a CHAT-realm
    // Uint8Array so the bundle's `u(e)` check (`id instanceof Uint8Array`)
    // against the chat realm constructor succeeds.
    try {
      const { chatStore } = await import("../bundle/register.ts");
      const slice = presenceSlice(sandbox);
      const ChatU8 = sandbox.getGlobal<Uint8ArrayConstructor>("Uint8Array") ?? Uint8Array;
      const idBytes = new ChatU8(16);
      idBytes.set(uuidToBytes(convId));
      const convEnvelope = { id: idBytes, str: convId };

      // CRITICAL: seed `state.messaging.conversations[convId]` BEFORE
      // calling `createPresenceSession`. The slice's
      // `createPresenceSession` ends up `await
      // firstValueFrom(observeConversationParticipants$)` inside
      // `PresenceServiceImpl`; that observable only emits when the conv
      // is in `state.messaging.conversations` (selector `mt.VN(state,
      // convIdStr)` reads `state.messaging.conversations[convIdStr]
      // ?.participants`). Without React running the bundle's normal
      // feed-pump, the slice is empty, the observable never emits, and
      // `createPresenceSession` hangs forever — the 1s poll below
      // times out and returns `undefined`, killing the entire
      // modern-presence path.
      //
      // The slice's own `fetchConversation` action would do this, but
      // it routes through `Sr(state)` which throws "Expected the
      // messaging client to be set" — the bundle's React layer
      // populates `state.messaging.client` via `initializeClient`, and
      // that path depends on `state.wasm.workerProxy` (a Comlink-wrapped
      // Web Worker we don't run). Playing the React role: write a
      // minimal `{participants: [{participantId: envelope}, ...]}`
      // record DIRECTLY into the slice via `chatStore.setState`. The
      // selector only reads `.participants[].participantId`; that's the
      // contract the presence observable needs and the only contract
      // we owe it.
      //
      // Participant envelopes are built from the SDK's already-resolved
      // self userId + conversation participant list. Skip when the conv
      // is already in the slice (e.g. priming on a hot path) so we don't
      // clobber a richer record the bundle's own action wrote.
      try {
        const store = chatStore(sandbox);
        const state = store.getState() as {
          messaging?: { conversations?: Record<string, unknown> };
        };
        const conversations = state.messaging?.conversations;
        const alreadySeeded = !!(conversations && conversations[convId]);
        process.stderr.write(`[trace.presence] ensurePresenceForConv slice-conversations.has(${convId.slice(0, 8)})=${alreadySeeded}\n`);
        if (!alreadySeeded) {
          // Build the envelope shape `{id: ChatU8(16), str}` for each
          // participant — same wrapper the bundle uses (module 74918's
          // `c(uuid)` factory), but we synthesize directly so the seed
          // doesn't depend on reaching into another bundle module.
          const selfUserId = await this._getSelfUserId(ctx);
          let participantUuids: string[] = [selfUserId];
          try {
            const all = await this.listConversations(selfUserId);
            const found = all.find((c) => c.conversationId === convId);
            if (found && found.participants.length) {
              participantUuids = found.participants;
            }
          } catch {
            // Best-effort — fall back to self-only. The selector still
            // emits (with one participant), unblocking the observable.
          }
          const buildEnv = (uuid: string): { id: Uint8Array; str: string } => {
            const b = new ChatU8(16);
            b.set(uuidToBytes(uuid));
            return { id: b, str: uuid };
          };
          const participants = participantUuids.map((u) => ({
            participantId: buildEnv(u),
          }));
          process.stderr.write(`[trace.presence] ensurePresenceForConv → setState messaging.conversations[${convId.slice(0, 8)}]={participants:${participants.length}}\n`);
          store.setState((s) => {
            const ms = (s as { messaging?: { conversations?: Record<string, unknown> } }).messaging;
            if (!ms) return s;
            // Direct mutation is the bundle's pattern — Zustand uses
            // Immer drafts internally for the messaging slice, so
            // mutating the draft + returning the same state object lands
            // the change. (See `(0,fr.wD)(r, e.messaging.conversations)`
            // in the bundle's slice — it mutates the conversations
            // object in place.)
            const conv = ms.conversations ?? (ms.conversations = {});
            conv[convId] = {
              conversation: { conversationId: convEnvelope, participants },
              participants,
              messages: new Map(),
              hasMoreMessages: false,
              isActive: false,
              loadingMessages: false,
            };
            return s;
          });
          process.stderr.write(`[trace.presence] ensurePresenceForConv ← setState ok\n`);
        }
      } catch (e) {
        process.stderr.write(`[trace.presence] ensurePresenceForConv messaging-slice seed THREW=${(e as Error).message?.slice(0, 200)}\n`);
      }

      process.stderr.write(`[trace.presence] ensurePresenceForConv → createPresenceSession({id-bytelen=${idBytes.byteLength}, str=${convId.slice(0, 8)}})\n`);
      slice.createPresenceSession(convEnvelope);
      // The slice populates `state.presence.presenceSession` AFTER an
      // async await on `n.createPresenceSession(...)` resolves; poll
      // briefly. Real cost is bounded — the inner await only blocks on
      // an `observeConversationParticipants` first-value pull.
      //
      // `candidate.conversationId` is the envelope ({id, str}) we passed
      // in — compare via `.str`. Note: the bundle may also receive
      // `firstValueFrom(participants$)` that NEVER emits if the conv
      // isn't in `state.messaging.conversations` (the slice's
      // observeConversationParticipants logs a warn and emits nothing).
      // The 1s poll budget below is a soft cap — if no session lands,
      // we proceed without one and fall back to the convMgr-only path.
      let session: BundlePresenceSession | undefined;
      for (let i = 0; i < 50; i++) {
        const candidate = presenceSlice(sandbox).presenceSession;
        if (candidate && candidate.conversationId?.str === convId) {
          session = candidate;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      if (session) {
        this.#presenceSessions.set(convId, session);
        process.stderr.write(`[trace.presence] ensurePresenceForConv ← createPresenceSession LANDED session-obj for conv=${convId.slice(0, 8)}\n`);
        return session;
      }
      process.stderr.write(`[trace.presence] ensurePresenceForConv ← createPresenceSession POLL-EXHAUSTED no session in slot after 1s\n`);
    } catch (e) {
      process.stderr.write(`[trace.presence] ensurePresenceForConv ← createPresenceSession THREW=${(e as Error).message?.slice(0, 200)}\n`);
    }
    return undefined;
  }

  /** @internal — single-flight bring-up gate. */
  #ensureSession(): Promise<void> {
    if (!this.#sessionPromise) {
      this.#sessionPromise = this.#bringUpSession().catch((e) => {
        // Reset so a future subscription can retry.
        this.#sessionPromise = undefined;
        throw e;
      });
    }
    return this.#sessionPromise;
  }

  /**
   * Boot the standalone chat WASM (mints Fidelius identity if needed),
   * grab the realm, then call `setupBundleSession` — wiring its
   * `onPlaintext` callback into our `#events.emit("message", ...)`.
   *
   * Conversation IDs are enumerated via `listConversations` so the WASM
   * has every conv pre-entered for live delivery + history pumps.
   *
   * @internal
   */
  async #bringUpSession(): Promise<void> {
    const ctx = await this._getCtx();
    const sandbox = ctx.sandbox;

    // Mint identity (warm-path: no-op if already cached) + grab realm.
    await mintFideliusIdentity(sandbox);
    const realm = await getStandaloneChatRealm(sandbox);
    this.#realm = realm;

    // Pull bearer + self userId from the auth slice. The slice's userId
    // lands via Zustand setState during `auth.initialize`, which can race
    // with our microtask timing — poll briefly with a short backoff
    // before throwing so consumers don't hit a transient miss when they
    // chain `.on()` directly off `await authenticate()`.
    const { authSlice } = await import("../bundle/register.ts");
    const auth = await import("./auth.ts");
    let userId: string | undefined;
    let bearer: string | undefined;
    // Poll up to 30s for the bundle's auth slice to populate `userId`. On
    // warm-path auth this is sub-second; on cold-fresh auth (no cookies,
    // no cached identity) the bundle's React-effect chain that lands
    // `state.auth.userId` can take 10-25s because it depends on multiple
    // async fetches. For BEARER, we have a separate SDK-side getter
    // (`getAuthToken`) that resolves immediately once authBundle()
    // returns — use it as a fast-path.
    bearer = auth.getAuthToken(ctx) || undefined;

    // Kick the bundle to populate `state.auth.userId` (on cold-fresh
    // auth, the field isn't set until `fetchUserData` runs — which the
    // bundle's React layer normally calls on page mount but we don't run).
    try {
      const slice0 = authSlice(sandbox) as Record<string, unknown>;
      const fetchUserData = slice0.fetchUserData as ((source?: string) => unknown) | undefined;
      if (typeof fetchUserData === "function") {
        // Best-effort fire — return value may be a Promise we don't need
        // to await; the side-effect is the slice update.
        const r = fetchUserData("messaging_session_bringup");
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).catch(() => {});
        }
      }
    } catch { /* tolerate */ }

    for (let i = 0; i < 300; i++) {
      const slice = authSlice(sandbox) as {
        userId?: string;
        me?: { userId?: string } | string;
        authToken?: { token?: string };
      };
      // Try several known userId locations on the slice. The cold-fresh
      // auth slice has only `me` + the action methods until fetchUserData
      // runs; warm-path runs have `userId` directly.
      const meAny = slice.me as { userId?: string } | string | undefined;
      userId =
        slice.userId ??
        (typeof meAny === "object" ? meAny?.userId : undefined) ??
        (typeof meAny === "string" ? meAny : undefined);
      bearer = slice.authToken?.token || bearer;
      if (userId && userId.length >= 32 && bearer) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!userId || userId.length < 32) {
      throw new Error(
        "Messaging.#bringUpSession: chat-bundle auth slice has no userId after 30s — auth.initialize may not have completed; verify client.authenticate() resolved cleanly",
      );
    }
    if (!bearer) {
      throw new Error(
        "Messaging.#bringUpSession: no bearer in auth slice or via getAuthToken — call client.authenticate() first",
      );
    }

    const cookieJar = getOrCreateJar(ctx.dataStore);

    // Enumerate convs so the bundle's WASM gets every conv pre-entered;
    // best-effort — empty list still works (live frames only, no
    // history pump).
    let convIds: string[] = [];
    try {
      const convs = await this.listConversations(userId);
      convIds = convs.map((c) => c.conversationId);
    } catch {
      /* fall through with empty list */
    }

    // TODO: typing/viewing/read inbound slots — Sess.create's slot 9 is
    // the messagingDelegate (onMessageReceived/onMessagesReceived,
    // wired below). The presence delegate lives on a sibling slot; once
    // identified, hook it here and emit `typing`/`viewing`/`read`.
    await setupBundleSession({
      realm,
      bearer,
      cookieJar,
      userAgent: ctx.userAgent,
      userId,
      conversationIds: convIds,
      dataStore: ctx.dataStore,
      onPlaintext: (msg) => {
        this.#events.emit("message", msg);
      },
      onSession: (session) => {
        this.#session = session;
      },
    });
  }

  // ── Outbound sends ──────────────────────────────────────────────────

  /**
   * Send a plain text DM into a conversation. Awaits messaging-session
   * bring-up before dispatching (so the first send pays the ~3s cold
   * cost; subsequent sends are free).
   *
   * Path: direct gRPC `MessagingCoreService.CreateContentMessage` with
   * the captured wire shape from recon. Snap's web client sends text DMs
   * with the body in plaintext at this layer — no Fidelius wrap on the
   * `CreateContentMessage` request envelope. Same wire shape as the
   * recon HAR `text-dm-create-content-message.req.bin`.
   *
   * @param convId - Hyphenated conversation UUID (from `listConversations`).
   * @param text - UTF-8 message body. Snap's UI line-breaks ~250 chars;
   *   server accepts longer but truncated rendering may apply.
   * @returns The message ID Snap assigned (UUID string from the response,
   *   OR our locally-generated client UUID if the response shape doesn't
   *   carry it under a known field — caller can dedupe on the inbound
   *   `message` event with `isSender === true`).
   */
  async sendText(convId: string, text: string): Promise<string> {
    await this.#ensureSession();
    if (!this.#session || !this.#realm) {
      throw new Error("Messaging.sendText: bundle session not available after bring-up");
    }

    // Bundle-driven path. Module 56639 export `pn` (`ae` in build's
    // internal naming) is the bundle's own sendText helper:
    //   pn(session, convRef, text, quotedMessageId?, cdMetadata?, botMention?)
    // It builds the ContentMessage envelope, encodes via the bundle's
    // own proto codec (matches what the SPA sends), drives Fidelius for
    // E2E convs, and dispatches via session.getConversationManager()
    // .sendMessageWithContent. Snap's WS push later fires our wrapped
    // messagingDelegate.onMessageReceived hook with isSender=true,
    // surfacing the outbound for confirmation.
    const sendsMod = this.#realm.wreq("56639") as Record<string, Function>;
    const pn = sendsMod.pn as Function | undefined;
    if (typeof pn !== "function") {
      throw new Error(
        "Messaging.sendText: module 56639 export `pn` (sendText) not a function — bundle shape may have shifted",
      );
    }

    // Build a realm-local conversation ref so the bundle's cross-realm
    // checks (Embind expects realm-local Uint8Array) pass.
    const VmU8 = await import("node:vm").then(
      (vm) => vm.runInContext("Uint8Array", this.#realm!.context) as Uint8ArrayConstructor,
    );
    const idBytes = new VmU8(16);
    idBytes.set(uuidToBytes(convId));
    const convRef = { id: idBytes, str: convId };

    // Resolve as soon as the bundle's send routine completes (`pn` returns
    // when the gRPC `CreateContentMessage` POST has been queued/dispatched
    // by the WASM session). We do NOT wait for a WS echo — empirically
    // unverified that Snap pushes our own outbound back to us via the
    // duplex channel; the previous 15s echo wait was speculative and
    // gated send latency on a callback that never reliably fires.
    //
    // For SOME conversation kinds (notably bots like My AI, conv type=50)
    // the bundle's `sendMessageWithContent` success callback never fires
    // even though the gRPC POST DOES go out and the bot DOES reply. The
    // gRPC dispatch is fire-and-forget on our side; the success callback
    // is the bundle's own bookkeeping that, for bot convs, depends on a
    // duplex notification we don't receive a handler for. Cap the wait at
    // 3s and resolve regardless — the message has been sent by the time
    // the WASM hands it to the gRPC layer (~tens of ms). Consumers can
    // confirm landing via `on("message", cb)` with `isSender === true`.
    const fallbackId = crypto.randomUUID();
    const sendPromise = pn(this.#session, convRef, text, undefined, undefined, false) as Promise<unknown>;
    await Promise.race([
      sendPromise.catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    return fallbackId;
  }

  /**
   * Send a persistent image attachment into a conversation. Image stays
   * in chat history (not ephemeral). Routes through the bundle's
   * messaging session — `sendMessageWithContent` builds the
   * `CreateContentMessage` envelope and the upload pipeline runs from
   * inside the WASM via the `mediaUploadDelegate`.
   *
   * @param convId - Hyphenated conversation UUID.
   * @param image - Raw image bytes (PNG / JPEG / WebP).
   * @param opts - Optional `caption` shown beside the image.
   * @returns The message ID assigned by the bundle's send pipeline.
   *
   * @remarks
   * Wire-tested via `sendText` only — `sendImage` compiles + the
   * bring-up path runs without throwing, but the bundle's `pe`/`E$`
   * media path needs a Blob shim and end-to-end media-upload primitives
   * we haven't yet exercised. If the bundle's `E$` send rejects, an
   * error surfaces; the caller can retry on the next bundle update.
   */
  async sendImage(
    convId: string,
    image: Uint8Array,
    opts?: { caption?: string },
  ): Promise<string> {
    await this.#ensureSession();
    const ctx = await this._getCtx();
    const selfUserId = await this._getSelfUserId(ctx);
    const conv = await this._lookupConversation(convId, selfUserId);
    if (!this.#session || !this.#realm) {
      throw new Error("Messaging.sendImage: bundle session not available after bring-up");
    }
    return sendMediaViaSession({
      realm: this.#realm,
      session: this.#session,
      kind: "image",
      convId,
      convType: conv.type,
      media: image,
      caption: opts?.caption,
      events: this.#events,
    });
  }

  /**
   * Send a disappearing snap to a conversation (destination kind 122).
   * Fidelius-encrypts the media body to the recipient's identity key —
   * the bundle's WASM owns this path end-to-end via its
   * `getSnapManager()` / `sendMessageWithContent` pipeline. Default is
   * view-once (no explicit timer); pass `{ timer: 5 }` to override.
   *
   * @param convId - Hyphenated conversation UUID.
   * @param media - Raw media bytes (image or video — bundle sniffs).
   * @param opts - Optional `timer` (display duration in seconds; omit
   *   for view-once).
   * @returns The message ID assigned by the bundle's send pipeline.
   *
   * @remarks
   * Wire-tested via `sendText` only — `sendSnap` compiles + brings up
   * the session without throwing. The bundle drives Fidelius encryption
   * for snaps inside its own send pipeline, so as long as the session is
   * up and the standalone realm has Blob support, the snap goes out
   * E2E-encrypted to the recipient's identity key.
   */
  async sendSnap(
    convId: string,
    media: Uint8Array,
    opts?: { timer?: number },
  ): Promise<string> {
    await this.#ensureSession();
    const ctx = await this._getCtx();
    const selfUserId = await this._getSelfUserId(ctx);
    const conv = await this._lookupConversation(convId, selfUserId);
    if (!this.#session || !this.#realm) {
      throw new Error("Messaging.sendSnap: bundle session not available after bring-up");
    }
    return sendMediaViaSession({
      realm: this.#realm,
      session: this.#session,
      kind: "snap",
      convId,
      convType: conv.type,
      media,
      timer: opts?.timer,
      events: this.#events,
    });
  }

  /** @internal — re-look up a conversation by id (cheap; cached at server). */
  private async _lookupConversation(
    convId: string,
    selfUserId: string,
  ): Promise<ConversationSummary> {
    const all = await this.listConversations(selfUserId);
    const found = all.find((c) => c.conversationId === convId);
    if (!found) {
      // Not in the synced list — treat as 1:1 DM (kind 13) with self as the
      // only known participant; the server will reject if the conv is
      // really stale. This codepath is rare (caller passed a convId not
      // returned by `listConversations`).
      return { conversationId: convId, type: 13, participants: [selfUserId] };
    }
    return found;
  }

  // ── Raw envelope reads ──────────────────────────────────────────────

  /**
   * Fetch the user's full conversation list via `SyncConversations`.
   * Returns one entry per conversation — the same set the SPA shows on
   * its left panel.
   *
   * @param selfUserId - Optional override for the calling user's UUID.
   *   When omitted, resolved from the chat-bundle's auth slice.
   */
  async listConversations(selfUserId?: string): Promise<ConversationSummary[]> {
    const ctx = await this._getCtx();
    selfUserId = selfUserId ?? await this._getSelfUserId(ctx);
    const w = new ProtoWriter();
    w.fieldMessage(1, (m) => m.fieldBytes(1, uuidToBytes(selfUserId)));
    w.fieldString(2, "useV4");
    w.fieldBytes(4, new Uint8Array(0));
    w.fieldVarint(5, 1);
    const respBytes = await this._grpcCall(ctx, "SyncConversations", w.finish());
    return parseSyncConversations(respBytes);
  }

  /**
   * Fetch raw encrypted message envelopes for the given conversations
   * via `BatchDeltaSync`.
   */
  async fetchEncryptedMessages(conversations: ConversationSummary[], selfUserId?: string): Promise<RawEncryptedMessage[]> {
    const ctx = await this._getCtx();
    selfUserId = selfUserId ?? await this._getSelfUserId(ctx);
    const w = new ProtoWriter();
    for (const c of conversations) {
      const otherUser = c.participants.find((p) => p !== selfUserId) ?? selfUserId;
      // Captured shape: { 2: {1: bytes16 convId}, 4: {1: bytes16 self},
      //                   6: {1: bytes16 other}, 7: varint=1 }
      w.fieldMessage(1, (m) => {
        m.fieldMessage(2, (mm) => mm.fieldBytes(1, uuidToBytes(c.conversationId)));
        m.fieldMessage(4, (mm) => mm.fieldBytes(1, uuidToBytes(selfUserId)));
        m.fieldMessage(6, (mm) => mm.fieldBytes(1, uuidToBytes(otherUser)));
        m.fieldVarint(7, 1);
      });
    }
    const respBytes = await this._grpcCall(ctx, "BatchDeltaSync", w.finish());
    return parseBatchDeltaSync(respBytes);
  }

  /** @internal */
  private async _getSelfUserId(ctx: ClientContext): Promise<string> {
    // Try the chat-bundle's auth slice first — has `userId` once the
    // session is brought up.
    try {
      const { authSlice } = await import("../bundle/register.ts");
      const slice = authSlice(ctx.sandbox) as { userId?: string };
      if (typeof slice.userId === "string" && slice.userId.length >= 32) {
        return slice.userId;
      }
    } catch { /* slice not available — fall through */ }
    throw new Error("Messaging._getSelfUserId: chat-bundle auth slice has no userId yet; pass selfUserId explicitly to listConversations / fetchEncryptedMessages");
  }

  /** @internal */
  private async _grpcCall(ctx: ClientContext, methodName: string, body: Uint8Array): Promise<Uint8Array> {
    const auth = await import("./auth.ts");
    const bearer = auth.getAuthToken(ctx);
    const sharedJar = getOrCreateJar(ctx.dataStore);
    const cookieHeader = (await sharedJar.getCookies("https://web.snapchat.com"))
      .map((c) => `${c.key}=${c.value}`)
      .join("; ");
    const framed = new Uint8Array(5 + body.byteLength);
    new DataView(framed.buffer).setUint32(1, body.byteLength, false);
    framed.set(body, 5);
    const url = `https://web.snapchat.com/messagingcoreservice.MessagingCoreService/${methodName}`;
    // mcs-cof-ids-bin: Snap's web client sends a bin-encoded protobuf
    // metadata listing the COF (Circle of Friends) feature ids the
    // client supports. CreateContentMessage in particular looks at this
    // header to gate delivery; without it Snap returns an OK trailer
    // but silently drops the message. The captured value below is the
    // exact bytes from recon-bin/text-dm-create-content-message.req.headers.json
    // and is stable across the chat-bundle build we vendor.
    const headers: Record<string, string> = {
      "authorization": `Bearer ${bearer}`,
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-user-agent": "grpc-web-javascript/0.1",
      "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
      "user-agent": ctx.userAgent,
      "accept": "*/*",
      "cookie": cookieHeader,
    };
    if (methodName === "CreateContentMessage") {
      headers["mcs-cof-ids-bin"] = "ChjSlcACiLO9AcSl8gLelrIBipe7AYzw4QE=";
    }
    const r = await nativeFetch(url, {
      method: "POST",
      headers,
      body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (r.status !== 200) {
      const grpcStatus = r.headers.get("grpc-status");
      const grpcMessage = r.headers.get("grpc-message");
      throw new Error(`Messaging._grpcCall(${methodName}) status=${r.status} grpc-status=${grpcStatus} grpc-message=${grpcMessage}`);
    }
    // gRPC-Web framing: each frame = 1-byte flag + 4-byte big-endian length
    // + payload. Flag bit 0x80 indicates a trailer-only frame (text key:val
    // pairs separated by \r\n). Walk every frame; the data frame is the
    // payload, trailer frames carry grpc-status / grpc-message.
    let pos = 0;
    let dataPayload: Uint8Array | undefined;
    let trailerStatus = 0;
    let trailerMessage = "";
    while (pos + 5 <= buf.byteLength) {
      const flag = buf[pos]!;
      const fLen = new DataView(buf.buffer, buf.byteOffset + pos + 1, 4).getUint32(0, false);
      const start = pos + 5;
      const end = start + fLen;
      if (end > buf.byteLength) break;
      const slice = buf.subarray(start, end);
      if ((flag & 0x80) === 0) {
        dataPayload = slice;
      } else {
        const trailerStr = new TextDecoder().decode(slice);
        const m = trailerStr.match(/grpc-status:\s*(\d+)/i);
        if (m) trailerStatus = parseInt(m[1]!);
        const mm = trailerStr.match(/grpc-message:\s*(.+)/i);
        if (mm) trailerMessage = mm[1]!.trim();
      }
      pos = end;
    }
    if (trailerStatus !== 0) {
      throw new Error(`Messaging._grpcCall(${methodName}) grpc-status=${trailerStatus} grpc-message=${trailerMessage}`);
    }
    if (!dataPayload) {
      // Some methods (write-only) legitimately return no data frame, only
      // an OK trailer. Return empty.
      return new Uint8Array(0);
    }
    return dataPayload;
  }
}

/**
 * Parse a SyncConversations response. Each top-level `f1` is one
 * conversation envelope; we extract `{conversationId, type, participants}`.
 *
 * @internal
 */
function parseSyncConversations(buf: Uint8Array): ConversationSummary[] {
  const out: ConversationSummary[] = [];
  const r = new ProtoReader(buf);
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) {
      const conv = r.bytes();
      const summary = parseOneSyncedConversation(conv);
      if (summary) out.push(summary);
    } else r.skip(n.wireType);
  }
  return out;
}

function parseOneSyncedConversation(buf: Uint8Array): ConversationSummary | null {
  const r = new ProtoReader(buf);
  let convId = "";
  let type = 0;
  const participants: string[] = [];
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) {
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 2) {
          const inner = sr.bytes();
          const ir = new ProtoReader(inner);
          for (let i = ir.next(); i; i = ir.next()) {
            if (i.field === 1 && i.wireType === 2) {
              const u = ir.bytes();
              if (u.byteLength === 16) convId = bytesToUuid(u);
            } else ir.skip(i.wireType);
          }
        } else if (s.field === 2 && s.wireType === 0) {
          type = Number(sr.varint());
        } else sr.skip(s.wireType);
      }
    } else if (n.field === 7 && n.wireType === 2) {
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 2) {
          const u = sr.bytes();
          if (u.byteLength === 16) participants.push(bytesToUuid(u));
        } else sr.skip(s.wireType);
      }
    } else r.skip(n.wireType);
  }
  return convId ? { conversationId: convId, type, participants } : null;
}

/**
 * Parse a BatchDeltaSync response and surface every encrypted message
 * envelope. Walks each conversation block; for each ContentMessage,
 * extracts `(conversationId, senderUserId, messageId, envelope bytes)`.
 *
 * If the message body contains a plaintext content sub-message (e.g. AI
 * bot replies are not E2E), surface that as `cleartextBody`.
 *
 * @internal
 */
function parseBatchDeltaSync(buf: Uint8Array): RawEncryptedMessage[] {
  const out: RawEncryptedMessage[] = [];
  const r = new ProtoReader(buf);
  // Top-level: repeated f1 (one per conversation block).
  // Each block wraps another f1 = SyncedConversation, which has:
  //   f1: type
  //   f2: timestamp
  //   f6: ConversationMetadata (subobjects)
  //   f3: ConversationLayout (subobjects)
  //   f4: ContentMessage (repeated)  ← the messages we want
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) {
      const block = r.bytes();
      // Block has one f1 wrapper containing the SyncedConversation
      const blockR = new ProtoReader(block);
      for (let b = blockR.next(); b; b = blockR.next()) {
        if (b.field === 1 && b.wireType === 2) {
          const sc = blockR.bytes();
          parseSyncedConversation(sc, out);
        } else blockR.skip(b.wireType);
      }
    } else r.skip(n.wireType);
  }
  return out;
}

function parseSyncedConversation(buf: Uint8Array, out: RawEncryptedMessage[]): void {
  const r = new ProtoReader(buf);
  let convId = "";
  const collected: RawEncryptedMessage[] = [];
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 6 && n.wireType === 2) {
      // ConversationMetadata — extract conversationId from f1.f1.f1
      const meta = r.bytes();
      const mr = new ProtoReader(meta);
      for (let m = mr.next(); m; m = mr.next()) {
        if (m.field === 1 && m.wireType === 2) {
          const sub = mr.bytes();
          const sr = new ProtoReader(sub);
          for (let s = sr.next(); s; s = sr.next()) {
            if (s.field === 1 && s.wireType === 2) {
              const inner = sr.bytes();
              const ir = new ProtoReader(inner);
              for (let i = ir.next(); i; i = ir.next()) {
                if (i.field === 1 && i.wireType === 2) {
                  const u = ir.bytes();
                  if (u.byteLength === 16) convId = bytesToUuid(u);
                } else ir.skip(i.wireType);
              }
            } else sr.skip(s.wireType);
          }
        } else mr.skip(m.wireType);
      }
    } else if (n.field === 4 && n.wireType === 2) {
      // ContentMessage
      const cm = r.bytes();
      const msg = parseContentMessage(cm, convId);
      if (msg) collected.push(msg);
    } else r.skip(n.wireType);
  }
  // Backfill convId on collected messages (in case f6 came after f4)
  for (const m of collected) {
    if (!m.conversationId) m.conversationId = convId;
    out.push(m);
  }
}

function parseContentMessage(buf: Uint8Array, conversationId: string): RawEncryptedMessage | null {
  const r = new ProtoReader(buf);
  let messageId = 0n;
  let senderUserId = "";
  let envelope = new Uint8Array(0);
  let eelEnvelope = new Uint8Array(0);
  let serverTimestampMs = 0n;
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 0) {
      messageId = r.varint();
    } else if (n.field === 2 && n.wireType === 2) {
      // {1: bytes16 senderUserId}
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 2) {
          const u = sr.bytes();
          if (u.byteLength === 16) senderUserId = bytesToUuid(u);
        } else sr.skip(s.wireType);
      }
    } else if (n.field === 3 && n.wireType === 2) {
      // ContentEnvelope
      envelope = new Uint8Array(r.bytes());
    } else if (n.field === 4 && n.wireType === 2) {
      // EelEncryption envelope — carries the AES-GCM ciphertext + metadata.
      // Snap *sometimes* embeds plaintext metadata (media URLs, timestamps,
      // snap IDs) here even when the message body itself is E2E-wrapped —
      // attachment bodies live on the CDN behind the URLs and the ciphertext
      // is just the message TEXT.
      eelEnvelope = new Uint8Array(r.bytes());
    } else if (n.field === 6 && n.wireType === 2) {
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 0) serverTimestampMs = sr.varint();
        else sr.skip(s.wireType);
      }
    } else r.skip(n.wireType);
  }
  if (!senderUserId) return null;
  // Surface plaintext from EITHER the ContentEnvelope OR the EelEncryption
  // envelope — Snap stores media URLs / snap IDs in plaintext alongside the
  // E2E-wrapped body.
  const cleartextBody = extractPlaintextBody(envelope) ?? extractPlaintextBody(eelEnvelope);
  return {
    conversationId,
    senderUserId,
    messageId,
    serverTimestampMs,
    envelope: eelEnvelope.byteLength > 0 ? eelEnvelope : envelope,
    cleartextBody,
  };
}

/**
 * Walk a proto buffer for plaintext text bodies. Picks up any UTF-8 string
 * field whose content is mostly ASCII-printable + has at least one letter.
 *
 * Non-E2E messages (AI bot, MEMORIES) carry the message text directly.
 * E2E messages embed plaintext METADATA — media URLs, snap IDs, signed
 * cookies — alongside the encrypted text body, so this returns *what's
 * available* (URL, ID, etc.) when no actual text body is present.
 *
 * Surfaces ALL strings as a `\n`-joined block when there are multiple,
 * so callers see the full plaintext context, not just the longest field.
 */
/**
 * Walk a CreateContentMessage response looking for a 16-byte UUID — the
 * server stamps the assigned messageId on the response envelope. Returns
 * the first 16-byte field's hyphenated form, or `undefined` if none
 * found.
 *
 * The response shape varies subtly by content kind, but every shape
 * carries the assigned message UUID somewhere as a 16-byte field; a
 * shallow walk through the top-level fields is sufficient.
 *
 * @internal
 */
function extractFirstUuidFromResp(envelope: Uint8Array): string | undefined {
  if (envelope.byteLength === 0) return undefined;
  let r: ProtoReader;
  try { r = new ProtoReader(envelope); } catch { return undefined; }
  while (r.pos < envelope.byteLength) {
    const n = r.next(); if (!n) break;
    if (n.wireType === 2) {
      let bb: Uint8Array;
      try { bb = r.bytes(); } catch { return undefined; }
      if (bb.byteLength === 16) return bytesToUuid(bb);
      // Recurse one level into nested messages
      let rr: ProtoReader;
      try { rr = new ProtoReader(bb); } catch { continue; }
      while (rr.pos < bb.byteLength) {
        const nn = rr.next(); if (!nn) break;
        if (nn.wireType === 2) {
          let ibb: Uint8Array;
          try { ibb = rr.bytes(); } catch { break; }
          if (ibb.byteLength === 16) return bytesToUuid(ibb);
        } else rr.skip(nn.wireType);
      }
    } else r.skip(n.wireType);
  }
  return undefined;
}

function extractPlaintextBody(envelope: Uint8Array): string | undefined {
  const found: string[] = [];
  function walk(b: Uint8Array, depth = 0): void {
    if (depth > 10 || b.byteLength === 0) return;
    let r: ProtoReader;
    try { r = new ProtoReader(b); } catch { return; }
    while (r.pos < b.byteLength) {
      const n = r.next(); if (!n) break;
      if (n.wireType === 2) {
        let bb: Uint8Array;
        try { bb = r.bytes(); } catch { return; }
        if (bb.byteLength >= 1 && bb.byteLength < 4096) {
          const txt = new TextDecoder("utf-8", { fatal: false }).decode(bb);
          let printable = 0; let letters = 0;
          for (let i = 0; i < bb.byteLength; i++) {
            const c = bb[i]!;
            if (c >= 0x20 && c <= 0x7e) printable++;
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
          }
          // Accept strings that are mostly printable AND have at least 2
          // letters (catch URLs, slugs, base64 IDs, message text). Reject
          // pure 16-byte UUIDs (handled separately) and very short noise.
          if (letters >= 2 && printable / bb.byteLength > 0.85 && bb.byteLength >= 4 && bb.byteLength !== 16) {
            found.push(txt);
          } else if (printable / bb.byteLength < 0.5 || bb.byteLength === 16) {
            // Almost certainly binary — try as nested message
            try { walk(bb, depth + 1); } catch { /* not msg */ }
          } else {
            // Mixed — try as message, fall back to text
            try { walk(bb, depth + 1); } catch { /* not msg */ }
          }
        } else {
          try { walk(bb, depth + 1); } catch { /* not msg */ }
        }
      } else r.skip(n.wireType);
    }
  }
  try { walk(envelope, 0); } catch { /* best-effort */ }
  if (found.length === 0) return undefined;
  // Dedupe + concat — caller sees the FULL plaintext context.
  const uniq = Array.from(new Set(found));
  uniq.sort((a, b) => b.length - a.length);
  return uniq.join(" | ");
}
