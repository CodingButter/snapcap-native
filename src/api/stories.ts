/**
 * Stories manager — broadcast-only `post()` API.
 *
 * # Surface today
 *
 *   - {@link Stories.post}: post media (image or video) to MY_STORY (the
 *     destination kind 122 with recipient = 16 bytes of `0x01`).
 *
 * # Lifecycle
 *
 * Reuses the messaging session brought up lazily by `Messaging.on(...)`
 * / `Messaging.sendText(...)`. The bundle's send pipeline owns upload +
 * Fidelius + dispatch end-to-end; we just project the media bytes into
 * the standalone realm and call the bundle's `HM` (sendSnap) entry with
 * MY_STORY destinations.
 *
 * @see {@link SnapcapClient.stories}
 */
import type { ClientContext } from "./_context.ts";
import {
  setupBundleSession,
  mintFideliusIdentity,
  getStandaloneChatRealm,
  type BundleMessagingSession,
  type PlaintextMessage,
  type StandaloneChatRealm,
} from "../bundle/chat/standalone/index.ts";
import { getOrCreateJar } from "../shims/cookie-jar.ts";
import { TypedEventBus, type Subscription } from "../lib/typed-event-bus.ts";
import { sendMediaViaSession } from "./_media_upload.ts";
import type { MessagingEvents } from "./messaging/index.ts";

/**
 * Stories domain manager — held as {@link SnapcapClient.stories}.
 *
 * @see {@link SnapcapClient}
 */
export class Stories {
  /**
   * Per-instance event bus used as the message-id capture sink for
   * outbound posts. Same shape as the Messaging bus so we can reuse the
   * `_media_upload.ts` helper.
   *
   * @internal
   */
  readonly #events = new TypedEventBus<MessagingEvents>();

  /**
   * Lazy bring-up handle. Stories doesn't strictly need the bundle
   * messaging session for posts that go through the direct
   * `MessagingCoreService.CreateContentMessage` path — but the
   * bundle-driven path (which we prefer) does, so we share the same
   * lazy bring-up gate.
   */
  #sessionPromise?: Promise<void>;
  #session?: BundleMessagingSession;
  #realm?: StandaloneChatRealm;

  /** @internal */
  constructor(private readonly _getCtx: () => Promise<ClientContext>) {}

  /**
   * Post media (image or video) to MY_STORY. The bundle's send pipeline
   * owns upload, encryption, and dispatch; we project the media bytes
   * into the standalone realm and call the bundle's `HM` (sendSnap)
   * entry with MY_STORY destinations from `storyDescModule.R9`.
   *
   * Auto-normalization (1080×1920 RGBA PNG) is the bundle's
   * responsibility once it sniffs the Blob; pass raw bytes through.
   *
   * @param media - Raw image or video bytes (PNG / JPEG / WebP / MP4).
   * @param opts - Reserved for caption + future story config (TODO).
   * @returns The story id assigned by the bundle's send pipeline.
   *
   * @remarks
   * Wire-tested through `Messaging.sendText` only — `post()` compiles
   * and the bring-up path runs without throwing. The bundle drives the
   * MY_STORY upload internally.
   */
  async post(media: Uint8Array, opts?: { caption?: string }): Promise<string> {
    void opts;
    await this.#ensureSession();
    if (!this.#session || !this.#realm) {
      throw new Error("Stories.post: bundle session not available after bring-up");
    }
    return sendMediaViaSession({
      kind: "story",
      realm: this.#realm,
      session: this.#session,
      media,
      caption: opts?.caption,
      events: this.#events,
    });
  }

  /**
   * Subscribe to outbound story-post completions. Currently shares the
   * same `message` event surface as Messaging — mostly useful for
   * extracting the canonical story id from the Embind delegate's
   * `isSender=true` callback.
   *
   * @internal — undocumented in the public surface today.
   */
  on(cb: (msg: PlaintextMessage) => void): Subscription {
    return this.#events.on("message", cb);
  }

  /** @internal — single-flight bring-up gate. Mirrors Messaging. */
  #ensureSession(): Promise<void> {
    if (!this.#sessionPromise) {
      this.#sessionPromise = this.#bringUpSession().catch((e) => {
        this.#sessionPromise = undefined;
        throw e;
      });
    }
    return this.#sessionPromise;
  }

  /**
   * Same lazy bring-up as {@link Messaging} — boots the standalone WASM,
   * grabs the realm, calls `setupBundleSession`. The bundle-realm session
   * is captured via `onSession` so subsequent send calls can drive it.
   *
   * @internal
   */
  async #bringUpSession(): Promise<void> {
    const ctx = await this._getCtx();
    const sandbox = ctx.sandbox;

    await mintFideliusIdentity(sandbox);
    const realm = await getStandaloneChatRealm(sandbox);
    this.#realm = realm;

    const { authSlice } = await import("../bundle/register/index.ts");
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
      throw new Error("Stories.#bringUpSession: chat-bundle auth slice has no userId after 2s — call client.authenticate() first");
    }
    if (!bearer) {
      throw new Error("Stories.#bringUpSession: chat-bundle auth slice has no bearer after 2s — call client.authenticate() first");
    }

    const cookieJar = getOrCreateJar(ctx.dataStore);
    await setupBundleSession({
      realm,
      bearer,
      cookieJar,
      userAgent: ctx.userAgent,
      userId,
      conversationIds: [],
      dataStore: ctx.dataStore,
      onPlaintext: (msg) => this.#events.emit("message", msg),
      onSession: (session) => {
        this.#session = session;
      },
    });
  }
}
