/**
 * `Messaging` class — inbound + outbound DM surface.
 *
 * Class shell: holds per-instance state on `#`-private fields, builds
 * a `MessagingInternal` accessor object once in the constructor, and
 * trampolines every public method through to a free function in a
 * sibling file. The free functions close over their `MessagingInternal`
 * arg so per-instance isolation holds without module-scope mutable
 * state (per `feedback_no_module_scope_state.md`).
 *
 * # Two layers in one class
 *
 * 1. **Raw envelope reads** (`listConversations`, `fetchEncryptedMessages`)
 *    — direct gRPC-Web calls to `MessagingCoreService`. Handy for
 *    inbox enumeration and historical message backfill that doesn't
 *    need decrypt.
 * 2. **Live decrypted stream + presence** (`on`, `setTyping`,
 *    `setViewing`, `setRead`) — boots Snap's own messaging session
 *    inside our standalone-WASM realm (`setupBundleSession` in
 *    `bundle/chat/standalone/session/setup.ts`) and emits plaintext `message` events
 *    through a `TypedEventBus`.
 *
 * # Lifecycle
 *
 * The bundle session bring-up is ~3s (mints/registers Fidelius
 * identity if needed, evals `f16f14e3` chunk, opens the duplex WS).
 * It's NOT done in the `SnapcapClient` constructor — consumers that
 * only want raw envelope reads shouldn't pay that cost. First
 * `on('message', ...)`, `setTyping`, or `setViewing` triggers a single
 * shared bring-up; subsequent calls reuse the same session.
 *
 * # Raw envelope path
 *
 *   - `SyncConversations` — returns the user's conversation list.
 *   - `BatchDeltaSync` — given a set of conv IDs, returns recent
 *     encrypted message envelopes per conv.
 *
 * Both use plain gRPC-Web POST framing; auth is bearer + parent-domain
 * cookies — same pattern as `api/fidelius.ts`.
 */
import type { ClientContext } from "../_context.ts";
import type { Subscription } from "../../lib/typed-event-bus.ts";
import { TypedEventBus } from "../../lib/typed-event-bus.ts";
import type {
  BundleMessagingSession,
  StandaloneChatRealm,
} from "../../bundle/chat/standalone/index.ts";
import type { BundlePresenceSession } from "../../bundle/types/index.ts";
import type { MessagingInternal, Cell } from "./internal.ts";
import type { MessagingEvents } from "./interface.ts";
import type { ConversationSummary, RawEncryptedMessage } from "./types.ts";
import { ensureSession } from "./bringup.ts";
import { subscribe } from "./subscribe.ts";
import { setTyping as setTypingImpl } from "./set-typing.ts";
import { setViewing as setViewingImpl, setRead as setReadImpl } from "./presence-out.ts";
import { sendText as sendTextImpl, sendImage as sendImageImpl, sendSnap as sendSnapImpl } from "./send.ts";
import {
  listConversations as listConversationsImpl,
  fetchEncryptedMessages as fetchEncryptedMessagesImpl,
} from "./reads.ts";

/**
 * Messaging manager — inbox enumeration + live decrypt + presence.
 *
 * @see {@link SnapcapClient.messaging}
 */
export class Messaging {
  /**
   * Per-instance event bus. Bridge code inside `bringup.ts` calls
   * `this.#events.emit("message", ...)`; consumers subscribe via
   * {@link Messaging.on}.
   */
  readonly #events = new TypedEventBus<MessagingEvents>();

  /**
   * Lazy bring-up handle. Resolved once the standalone-chat realm is
   * up and `setupBundleSession` has wired the messaging delegate.
   * Cell-boxed so `bringup.ts#ensureSession` can write through.
   */
  readonly #sessionPromiseCell: Cell<Promise<void> | undefined> = { value: undefined };

  /**
   * Bundle-realm messaging session captured during bring-up — the
   * result of `En.createMessagingSession(...)`. `sendText` /
   * `sendImage` / `sendSnap` drive `sendMessageWithContent` through
   * it.
   *
   * @internal
   */
  #session?: BundleMessagingSession;

  /**
   * Standalone-chat realm captured during bring-up. Holds the
   * webpack `wreq` we use to reach the bundle's send entries (module
   * 56639 — `pn` / `E$` / `HM`).
   *
   * @internal
   */
  #realm?: StandaloneChatRealm;

  /**
   * Once-per-Messaging-instance flag — set to `true` after the first
   * successful `state.presence.initializePresenceServiceTs(bridge)`
   * call. Subsequent typing/viewing calls skip the init.
   *
   * Lives as a `#` private instance field, boxed in a `Cell` so the
   * sibling presence helpers can flip it through the
   * `MessagingInternal` accessor without taking a reference to the
   * class. Per-instance — multi-instance-safe by construction.
   *
   * @internal
   */
  readonly #presenceInitialized: Cell<boolean> = { value: false };

  /**
   * Per-conv `BundlePresenceSession` cache. The bundle's
   * `state.presence.presenceSession` slot is single-instance
   * (one-active-session-globally), so creating a session for conv B
   * disposes the one for conv A. We still cache by convId so
   * back-to-back calls on the same conv reuse the live session.
   *
   * Lives as a `#` private instance field, keyed by per-instance
   * convId strings — NOT module scope. Each `Messaging` instance owns
   * its own Map; multi-instance-safe by construction.
   *
   * @internal
   */
  readonly #presenceSessions = new Map<string, BundlePresenceSession>();

  /**
   * Per-instance accessor handed to every sibling free function so
   * they can read/mutate the class's private state without dragging
   * the class into module scope. Built once in the constructor.
   *
   * @internal
   */
  readonly #internal: MessagingInternal;

  /** @internal */
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {
    const internal: MessagingInternal = {
      ctx: () => this._getCtx(),
      events: this.#events,
      ensureSession: () => ensureSession(internal, this.#sessionPromiseCell),
      session: {
        get: () => this.#session,
        set: (v) => { this.#session = v; },
      },
      realm: {
        get: () => this.#realm,
        set: (v) => { this.#realm = v; },
      },
      presenceInitialized: this.#presenceInitialized,
      presenceSessions: this.#presenceSessions,
    };
    this.#internal = internal;
  }

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
    return subscribe(this.#internal, event, cb, opts);
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
   * @example
   * ```ts
   * await messaging.setTyping(convId, 1500);
   * await messaging.sendText(convId, "hello");
   * ```
   */
  setTyping(convId: string, durationMs: number): Promise<void> {
    return setTypingImpl(this.#internal, convId, durationMs);
  }

  /**
   * Mark `convId` as actively viewed (chat-open / focused) for `durationMs`,
   * then auto-clear with an `exitConversation` pulse.
   */
  setViewing(convId: string, durationMs: number): Promise<void> {
    return setViewingImpl(this.#internal, convId, durationMs);
  }

  /**
   * Mark `messageId` in `convId` as read (fires a read-receipt frame).
   * Resolves once the bundle has dispatched the notification.
   *
   * @param convId - Hyphenated conversation UUID.
   * @param messageId - Server message id (bigint) or its decimal-string
   *   form.
   */
  setRead(convId: string, messageId: string | bigint): Promise<void> {
    return setReadImpl(this.#internal, convId, messageId);
  }

  // ── Outbound sends ──────────────────────────────────────────────────

  /**
   * Send a plain text DM into a conversation. Awaits messaging-session
   * bring-up before dispatching (so the first send pays the ~3s cold
   * cost; subsequent sends are free).
   *
   * @param convId - Hyphenated conversation UUID (from `listConversations`).
   * @param text - UTF-8 message body.
   * @returns The message ID Snap assigned (or a locally-generated client UUID).
   */
  sendText(convId: string, text: string): Promise<string> {
    return sendTextImpl(this.#internal, convId, text);
  }

  /**
   * Send a persistent image attachment into a conversation. Image stays
   * in chat history (not ephemeral).
   *
   * @param convId - Hyphenated conversation UUID.
   * @param image - Raw image bytes (PNG / JPEG / WebP) or a filesystem path.
   * @param opts - Optional `caption` (sent as a separate text message
   *   immediately after; matches Snap's UI).
   */
  sendImage(
    convId: string,
    image: Uint8Array | string,
    opts?: { caption?: string },
  ): Promise<void> {
    return sendImageImpl(this.#internal, convId, image, opts);
  }

  /**
   * Send a disappearing snap to a conversation (destination kind 122).
   * Default is view-once; pass `{ timer: 5 }` to override.
   *
   * @param convId - Hyphenated conversation UUID.
   * @param media - Raw media bytes.
   * @param opts - Optional `timer` (display duration in seconds).
   */
  sendSnap(
    convId: string,
    media: Uint8Array,
    opts?: { timer?: number },
  ): Promise<string> {
    return sendSnapImpl(this.#internal, convId, media, opts);
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
    return listConversationsImpl(ctx, selfUserId);
  }

  /**
   * Fetch raw encrypted message envelopes for the given conversations
   * via `BatchDeltaSync`.
   */
  async fetchEncryptedMessages(
    conversations: ConversationSummary[],
    selfUserId?: string,
  ): Promise<RawEncryptedMessage[]> {
    const ctx = await this._getCtx();
    return fetchEncryptedMessagesImpl(ctx, conversations, selfUserId);
  }
}
