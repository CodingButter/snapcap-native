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
 *    {@link Messaging.setTyping}, {@link Messaging.setViewing}) — boots
 *    Snap's own messaging session inside our standalone-WASM realm
 *    (`setupBundleSession` in `auth/fidelius-decrypt.ts`) and emits
 *    plaintext `message` events through a {@link TypedEventBus}.
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
  type PlaintextMessage,
} from "../auth/fidelius-decrypt.ts";
import {
  mintFideliusIdentity,
  getStandaloneChatRealm,
} from "../auth/fidelius-mint.ts";

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
   * Show typing indicator in `convId` for `durationMs`. Returns a
   * Promise resolving when `durationMs` elapses, so consumers can
   * compose:
   *
   * ```ts
   * await messaging.setTyping(convId, 1500);
   * await messaging.send(convId, "hello");
   * ```
   *
   * @remarks
   * Stub today — the underlying WS frame isn't yet wired (the bundle's
   * outbound presence path lives on a sibling manager off the session
   * object; mapping pending). Resolves after `durationMs` so the
   * compose-await pattern works without firing a real frame.
   */
  async setTyping(convId: string, durationMs: number): Promise<void> {
    void convId;
    await this.#ensureSession();
    // TODO: wire to bundle's session presence manager for real WS frame.
    await new Promise((r) => setTimeout(r, durationMs));
  }

  /**
   * Mark `convId` as actively viewed for `durationMs`. Same compose-await
   * pattern as {@link Messaging.setTyping}.
   *
   * @remarks
   * Stub today — see {@link Messaging.setTyping} note.
   */
  async setViewing(convId: string, durationMs: number): Promise<void> {
    void convId;
    await this.#ensureSession();
    // TODO: wire to bundle's session presence manager for real WS frame.
    await new Promise((r) => setTimeout(r, durationMs));
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

    // Pull bearer + self userId from the auth slice. The slice's userId
    // lands via Zustand setState during `auth.initialize`, which can race
    // with our microtask timing — poll briefly with a short backoff
    // before throwing so consumers don't hit a transient miss when they
    // chain `.on()` directly off `await authenticate()`.
    const { authSlice } = await import("../bundle/register.ts");
    let userId: string | undefined;
    let bearer: string | undefined;
    for (let i = 0; i < 20; i++) {
      const slice = authSlice(sandbox) as {
        userId?: string;
        authToken?: { token?: string };
      };
      userId = slice.userId;
      bearer = slice.authToken?.token;
      if (userId && userId.length >= 32 && bearer) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!userId || userId.length < 32) {
      throw new Error(
        "Messaging.#bringUpSession: chat-bundle auth slice has no userId after 2s — call client.authenticate() first",
      );
    }
    if (!bearer) {
      throw new Error(
        "Messaging.#bringUpSession: chat-bundle auth slice has no bearer after 2s — call client.authenticate() first",
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
    });
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
    const r = await nativeFetch(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${bearer}`,
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "grpc-web-javascript/0.1",
        "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
        "user-agent": ctx.userAgent,
        "accept": "*/*",
        "cookie": cookieHeader,
      },
      body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (r.status !== 200) {
      const grpcStatus = r.headers.get("grpc-status");
      const grpcMessage = r.headers.get("grpc-message");
      throw new Error(`Messaging._grpcCall(${methodName}) status=${r.status} grpc-status=${grpcStatus} grpc-message=${grpcMessage}`);
    }
    if (buf.byteLength < 5) {
      throw new Error(`Messaging._grpcCall(${methodName}): truncated response (got ${buf.byteLength} bytes)`);
    }
    const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
    return buf.subarray(5, 5 + len);
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
