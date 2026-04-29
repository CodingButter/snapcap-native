/**
 * SnapcapClient — main entry point.
 *
 * Two factory paths:
 *   - fromCredentials({ username, password }) — does the full native login
 *     flow (kameleon attestation → WebLoginService 2-step → SSO bearer →
 *     www.snapchat.com cookie seed).
 *   - fromAuth(savedBlob) — picks up where a previous session left off.
 *     Useful for not paying the ~3-4s native-login cost on every process
 *     start.
 *
 * Internally a SnapcapClient owns:
 *   - a CookieJar with __Host-sc-a-auth-session + parent-domain cookies
 *   - a current bearer string (short-lived)
 *   - a refresh function bound to its jar (auto-invoked on 401)
 *   - a `self: User` populated lazily (currently externally; auto-discovery
 *     lands once we wire up GetSnapchatterPublicInfo)
 *
 * Two layers of API:
 *   - Low-level primitives — take IDs, return Promises. Useful when you
 *     already have an ID from a DB/URL/webhook.
 *   - Domain objects (Conversation, User) — wrap the primitives with
 *     ergonomic methods. Returned by the high-level helpers
 *     (`getConversations()`, `conversation()`).
 */
import { CookieJar } from "tough-cookie";
import { nativeLogin, type LoginCredentials } from "./auth/login.ts";
import { mintBearer } from "./auth/sso.ts";
import { listFriends, syncFriendDataRaw } from "./api/friends.ts";
import { addFriends } from "./api/friending.ts";
import { searchUsers } from "./api/search.ts";
import { buildPresenceBody, PresenceCounter } from "./api/presence.ts";
// PresenceCounter is referenced in publishPresence's docs and
// _publishViewing — explicit import keeps tree-shaking clean.
import { connectDuplex, type Duplex } from "./transport/duplex.ts";
import { highLowToUuid } from "./transport/proto-encode.ts";
import {
  Conversation,
  sendTypingNotification,
  updateConversationView,
  markMessageViewed,
  syncConversations,
  TypingActivity,
  ConversationViewState,
  type ConversationKind,
} from "./api/messaging.ts";
import { User } from "./api/user.ts";
import { callRpc, type GrpcMethodDesc, type HeaderTransform } from "./transport/grpc-web.ts";
import { mintFideliusIdentity, type FideliusIdentity } from "./auth/fidelius-mint.ts";
import { initializeWebKey, stripOriginReferer } from "./api/fidelius.ts";
import { queryMessages, type QueryMessagesResponse } from "./api/inbox.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/**
 * Serialized form of a Fidelius identity stored in the auth blob.
 * Bytes are hex-encoded so the blob is plain JSON.
 *
 * SECURITY: `privateKey` is the long-lived root of E2E encryption for
 * this account. Snap's server never sees it; if you lose this blob the
 * identity can't be recovered (Snap won't let the same user register
 * a second one). Treat the whole blob as credential-grade.
 */
export type FideliusIdentityBlob = {
  publicKey: string;     // hex (65 bytes, 0x04-prefixed P-256)
  privateKey: string;    // hex (32 bytes)
  identityKeyId: string; // hex (32 bytes)
  rwk: string;           // hex (16 bytes)
  version: number;
};

export type SnapcapAuthBlob = {
  /** Serialized tough-cookie jar (jar.toJSON()). */
  jar: object;
  /** Most recent bearer (may be expired; refresh-on-401 will re-mint). */
  bearer: string;
  /** UA fingerprint we used at login — keep for consistency on subsequent calls. */
  userAgent: string;
  /** Cached self user (saves a round-trip on rehydrate). */
  self?: { userId: string; username?: string; displayName?: string };
  /**
   * E2E identity. Present once `fromCredentials` has minted + registered
   * the user's Fidelius key. Restoring a blob without it = no E2E ops
   * (sending snaps + reading inbound bodies will throw).
   */
  fidelius?: FideliusIdentityBlob;
};

export type FromCredentialsOpts = {
  credentials: LoginCredentials;
  userAgent?: string;
};

export type FromAuthOpts = {
  auth: SnapcapAuthBlob;
};

export class SnapcapClient {
  private jar: CookieJar;
  private bearer: string;
  private userAgent: string;

  /**
   * The logged-in user. Populated automatically when the SDK can derive it
   * (currently from the saved auth blob if present); otherwise the consumer
   * should set it via `setSelf()` before calling Conversation methods.
   *
   * Auto-discovery from a self-info RPC is tracked separately (see
   * task #50 in the project notes).
   */
  public self?: User;

  /**
   * Long-lived Fidelius E2E identity for this account. Populated by
   * `fromCredentials` (mint via WASM + register with server) or
   * `fromAuth` (deserialize from blob). Required for sending snaps
   * and reading inbound message bodies.
   */
  public fidelius?: FideliusIdentity;

  private constructor(jar: CookieJar, bearer: string, userAgent: string, self?: User, fidelius?: FideliusIdentity) {
    this.jar = jar;
    this.bearer = bearer;
    this.userAgent = userAgent;
    this.self = self;
    this.fidelius = fidelius;
  }

  static async fromCredentials(opts: FromCredentialsOpts): Promise<SnapcapClient> {
    const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    const jar = new CookieJar();
    await nativeLogin({ credentials: opts.credentials, jar, userAgent });
    const { bearer } = await mintBearer({ jar, userAgent });
    const client = new SnapcapClient(jar, bearer, userAgent);
    // Auto-discover self user. SyncFriendData embeds the logged-in user's
    // own metadata alongside the friend list — we just have to walk it.
    // Best-effort: if discovery fails, leave self unset and let the caller
    // call setSelf() manually.
    try {
      await client.resolveSelf(opts.credentials.username);
    } catch {
      // tolerate — consumer can still operate via setSelf()
    }
    // Mint + register Fidelius identity. Boot cost is one-time
    // (~250ms WASM init); subsequent `fromAuth(blob)` skips it
    // entirely. If the user has already registered an identity from
    // a different installation, the InitializeWebKey call returns
    // 401 — we surface that as a warning + leave fidelius undefined,
    // since the SDK can't recover the original private key.
    try {
      const identity = await mintFideliusIdentity();
      const fideliusRpc = client.makeRpc(stripOriginReferer);
      await initializeWebKey(fideliusRpc, identity);
      client.fidelius = identity;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("401") || msg.includes("unauthorized")) {
        console.warn(
          "[snapcap] Fidelius identity already registered for this account from a previous session. " +
            "E2E operations (snaps, inbound message bodies) will be unavailable in this client. " +
            "If you need them, locate the original blob or have Snap reset the account's web identity.",
        );
      } else {
        console.warn(`[snapcap] Fidelius identity init failed: ${msg.slice(0, 200)}`);
      }
    }
    return client;
  }

  static async fromAuth(opts: FromAuthOpts): Promise<SnapcapClient> {
    const jar = await CookieJar.deserialize(opts.auth.jar as never);
    const self = opts.auth.self
      ? new User(opts.auth.self.userId, opts.auth.self.username, opts.auth.self.displayName)
      : undefined;
    const fidelius = opts.auth.fidelius
      ? deserializeFidelius(opts.auth.fidelius)
      : undefined;
    return new SnapcapClient(jar, opts.auth.bearer, opts.auth.userAgent, self, fidelius);
  }

  /**
   * Override the self-user. Auto-discovery covers the typical case
   * (`fromCredentials` walks SyncFriendData and finds the logged-in
   * user's own metadata), so this is mostly an escape hatch for callers
   * who load auth from an old blob without `self` cached.
   */
  setSelf(user: User): void {
    this.self = user;
  }

  /**
   * Resolve the logged-in user from server-side data. Calls SyncFriendData
   * (which embeds the caller's own user record alongside the friend list)
   * and matches on `mutableUsername`. Sets `this.self` and returns it.
   *
   * Used internally by `fromCredentials`. Consumers can call directly when
   * loading from an old auth blob that doesn't have `self` cached.
   */
  async resolveSelf(username: string): Promise<User> {
    // Pull the raw SyncFriendData record (which embeds the self-user) and
    // walk it. listFriends() returns User[] now and would have already
    // dropped self if we knew our userId — but we don't yet.
    const raw = await syncFriendDataRaw(this.makeRpc());
    const found = findSelf(raw, username);
    if (!found) {
      throw new Error(`could not resolve self user "${username}" from SyncFriendData response`);
    }
    this.self = found;
    return found;
  }

  /** Serialize current session for reuse (auth.bearer may be expired; refresh-on-401 covers it). */
  async toAuthBlob(): Promise<SnapcapAuthBlob> {
    return {
      jar: (await this.jar.serialize()) as object,
      bearer: this.bearer,
      userAgent: this.userAgent,
      self: this.self?.toJSON(),
      fidelius: this.fidelius ? serializeFidelius(this.fidelius) : undefined,
    };
  }

  // ── Duplex WS (presence + typing) ──────────────────────────────────

  private duplex: Promise<Duplex> | null = null;

  /**
   * Lazy-open the persistent duplex WebSocket. Real-time presence
   * (viewing/typing indicators) only fans out to recipients when our
   * session has an open WS to aws.duplex.snapchat.com — gRPC alone won't
   * do it. We open once, hold for the lifetime of the client, and reuse
   * across every conversation.
   */
  private getDuplex(): Promise<Duplex> {
    if (!this.duplex) {
      this.duplex = (async () => {
        const dx = await connectDuplex({ bearer: this.bearer, jar: this.jar, userAgent: this.userAgent });
        await dx.ready;
        // If the server kicks us off (another session displaced ours, auth
        // dropped, etc.), drop the cached promise so the next presence
        // call reconnects with a fresh handshake.
        dx.onClosed((info) => {
          this.duplex = null;
          if (info.kind === "kicked") {
            console.warn(
              `[snapcap] duplex WS closed: another session connected as the same user (code=${info.code}). ` +
              `Snap allows one active session per account; the SDK and a browser/app session for the same ` +
              `user can't coexist. Will reconnect on next presence call.`,
            );
          } else if (info.kind === "auth") {
            console.warn(`[snapcap] duplex WS closed: auth rejected (code=${info.code}, reason=${info.reason})`);
          }
        });
        return dx;
      })();
    }
    return this.duplex;
  }

  /**
   * Publish a presence frame on the conversation. Counter is monotonic
   * per-WS-connection — first call returns 1 (= VIEWING), subsequent
   * calls increment. The server reads counter==1 as "subscribe/viewing"
   * and counter > 1 as activity (typing).
   */
  private async publishPresence(
    conversationId: string,
    peerUserId: string,
    counter: number,
  ): Promise<void> {
    if (!this.self) {
      throw new Error("publishPresence requires client.self — call resolveSelf() or fromCredentials() first");
    }
    const dx = await this.getDuplex();
    const body = buildPresenceBody({
      senderUserId: this.self.userId,
      conversationId,
      sessionId: dx.sessionId,
      counter,
    });
    dx.sendTransient("presence", body, peerUserId);
  }

  /**
   * Internal: called by Conversation.setTyping(durationMs).
   * Publishes an ACTIVITY pulse (counter > 1) to the duplex WS — server
   * fans out as "typing…" to the recipient.
   */
  async _publishTyping(conversationId: string, peerUserId: string): Promise<void> {
    const dx = await this.getDuplex();
    // First-ever publish on this WS uses counter=1 which means "viewing",
    // not "typing". Bump past 1 if we're at the start of the connection.
    let c = dx.nextCounter();
    if (c === 1) c = dx.nextCounter();
    await this.publishPresence(conversationId, peerUserId, c);
  }

  /**
   * Internal: called by Conversation.markViewed().
   * Publishes a VIEWING pulse (counter=1) — recipient sees the
   * "in chat" indicator (bitmoji avatar pose changes).
   */
  async _publishViewing(conversationId: string, peerUserId: string): Promise<void> {
    // VIEWING is always counter=1 regardless of monotonic state — that's
    // the protocol convention: 1 = "I'm subscribed to this conversation".
    await this.publishPresence(conversationId, peerUserId, PresenceCounter.VIEWING);
  }

  /** Mint a fresh bearer from the current cookie jar. Used by 401 retry. */
  private async refreshBearer(): Promise<string | null> {
    try {
      const { bearer } = await mintBearer({ jar: this.jar, userAgent: this.userAgent });
      this.bearer = bearer;
      return bearer;
    } catch {
      // If refresh fails (cookie expired), surface the original 401 so
      // callers can re-login.
      return null;
    }
  }

  // ── High-level domain-object API ────────────────────────────────────

  /**
   * Fetch the list of conversations the logged-in user is in. Returns
   * `Conversation` instances bound to this client — call methods like
   * `chat.setTyping()` directly without re-passing IDs.
   *
   * Requires `client.self` to be populated.
   */
  async getConversations(): Promise<Conversation[]> {
    if (!this.self) {
      throw new Error(
        "client.getConversations() requires client.self to be set. " +
        "Call client.setSelf(new User(uuid)) first, or wait for self-discovery (task #50).",
      );
    }
    const raw = await syncConversations(this.makeRpc(), this.self.userId);
    return raw.map((r) => {
      const participants = r.participantUserIds.map((uid) => new User(uid));
      const kind = inferKind(r.kindCode, participants.length);
      return new Conversation(this, {
        conversationId: r.conversationId,
        participants,
        kind,
        lastActivityAt: r.lastActivityMs ? new Date(r.lastActivityMs) : undefined,
      });
    });
  }

  /**
   * Build a Conversation handle for a known conversation ID. Useful when
   * you've persisted IDs in your own DB and want to skip the
   * SyncConversations round-trip.
   *
   * `participantUserIds` is optional but improves the resulting handle's
   * `friend` accessor; without it the SDK can't tell who the other party
   * is in a DM.
   */
  conversation(conversationId: string, participantUserIds: string[] = []): Conversation {
    return new Conversation(this, {
      conversationId,
      participants: participantUserIds.map((uid) => new User(uid)),
      kind: participantUserIds.length === 2 ? "dm" : "unknown",
    });
  }

  // ── Low-level primitives (functional, take IDs) ─────────────────────

  async listFriends(): Promise<User[]> {
    return await listFriends(this.makeRpc(), this.self?.userId);
  }

  /**
   * Send a friend request to the given user(s). `source` defaults to
   * "dweb_add_friend" (the value the web client sends when the user clicks
   * "Add" on a search result).
   */
  async addFriend(userId: string | string[], source?: string): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId];
    await addFriends(this.makeRpc(), ids, source);
  }

  /**
   * Post an image to MY_STORY (the user's own story feed). Returns when
   * the server accepts the post; friends see it in their story feeds via
   * Snap's normal fanout. Requires `client.self.username`.
   *
   * The image is auto-normalized to 1080×1920 RGBA PNG (center-cropped to
   * 9:16) — Snap's server silently drops stories built from anything else
   * that doesn't look like what its own camera produces. Pass
   * `skipNormalize: true` only if you've pre-conformed the bytes yourself.
   */
  async postStory(bytes: Uint8Array, opts?: { skipNormalize?: boolean }): Promise<void> {
    if (!this.self?.username) {
      throw new Error("postStory requires self.username — call fromCredentials() or resolveSelf() first");
    }
    const { postStory } = await import("./api/media.ts");
    const { nativeFetch } = await import("./transport/native-fetch.ts");
    await postStory(this.makeRpc(), nativeFetch, this.self.userId, this.self.username, {
      bytes, skipNormalize: opts?.skipNormalize,
    });
  }

  /**
   * Fetch recent messages for a conversation. Returns the raw response
   * payload — caller decodes (typed walker not yet available because we
   * haven't captured a non-empty inbox-fetch in the wild yet).
   *
   * Used as the first half of inbound message retrieval; the second half
   * (Fidelius decryption) lives in api/inbox.ts as `decryptFideliusEnvelope`.
   */
  async fetchMessages(conversationId: string, opts?: { limit?: number; secondary?: number }): Promise<QueryMessagesResponse> {
    if (!this.self?.userId) {
      throw new Error("fetchMessages requires self.userId — call resolveSelf() or fromCredentials() first");
    }
    return await queryMessages(this.makeRpc(), {
      conversationId,
      selfUserId: this.self.userId,
      limit: opts?.limit,
      secondary: opts?.secondary,
    });
  }

  /**
   * Search Snap's user index by query string. Returns User objects with
   * userId, username, and displayName populated where available.
   */
  async searchUsers(query: string, pageSize?: number): Promise<User[]> {
    return await searchUsers(query, {
      jar: this.jar,
      userAgent: this.userAgent,
      bearer: this.bearer,
      refreshBearer: () => this.refreshBearer(),
    }, pageSize);
  }

  /**
   * Send a single typing pulse. Caller is responsible for refreshing if
   * they want the indicator to persist; for the auto-refresh behavior,
   * use `Conversation.setTyping(durationMs)` instead.
   */
  async sendTypingNotification(
    conversationId: string,
    userId: string,
    typingType: number = TypingActivity.TEXT,
  ): Promise<void> {
    await sendTypingNotification(this.makeRpc(), conversationId, userId, typingType);
  }

  async updateConversationView(
    conversationId: string,
    userId: string,
    state: number = ConversationViewState.ACTIVE,
  ): Promise<void> {
    await updateConversationView(this.makeRpc(), conversationId, userId, state);
  }

  async markMessageViewed(
    messageId: bigint,
    conversationId: string,
    userId: string,
    action: number = 15,
  ): Promise<void> {
    await markMessageViewed(this.makeRpc(), messageId, conversationId, userId, action);
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Expose `rpc` to friends (Conversation, future API modules) so they can
   * call into the transport without holding a back-ref to the whole client.
   */
  get rpc(): { unary: (method: GrpcMethodDesc<unknown, unknown>, request: unknown) => Promise<unknown> } {
    return this.makeRpc();
  }

  /**
   * Build an `rpc.unary` impl bound to this client's jar/bearer/refresh.
   *
   * Pass `transformHeaders` to mutate the default header bag for every
   * call routed through this rpc instance. Useful when a service
   * rejects headers our regular calls add — e.g. Fidelius's gateway
   * 401s if Origin/Referer are present, so its API module builds its
   * own rpc with `(h) => { delete h.origin; delete h.referer; return h; }`.
   *
   * Returning a NEW object is recommended (don't mutate input).
   */
  makeRpc(transformHeaders?: HeaderTransform): {
    unary: (
      method: GrpcMethodDesc<unknown, unknown>,
      request: unknown,
    ) => Promise<unknown>;
  } {
    return {
      unary: async (method, request) => {
        // AtlasGw + most chat-bundle services live on web.snapchat.com.
        // If we add accounts.snapchat.com services later we'll need to
        // route based on serviceName.
        return await callRpc({
          method,
          request,
          host: "https://web.snapchat.com",
          jar: this.jar,
          userAgent: this.userAgent,
          bearer: this.bearer,
          refreshBearer: () => this.refreshBearer(),
          origin: "https://www.snapchat.com",
          referer: "https://www.snapchat.com/",
          transformHeaders,
        });
      },
    };
  }
}

function inferKind(kindCode: number, participantCount: number): ConversationKind {
  // kindCode 2 = DM in the captures we have; haven't seen group/myStory codes yet.
  if (kindCode === 2 && participantCount === 2) return "dm";
  if (participantCount > 2) return "group";
  return "unknown";
}

/**
 * Walk a SyncFriendData response looking for the logged-in user's own
 * record (matched by `mutableUsername === username`). The self-user is
 * included alongside the friend list — same shape as a Friend entry.
 */
function findSelf(payload: unknown, username: string): User | null {
  const stack: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    if (obj.mutableUsername === username && obj.userId && typeof obj.userId === "object") {
      const id = obj.userId as { highBits?: bigint | string; lowBits?: bigint | string };
      if (id.highBits !== undefined && id.lowBits !== undefined) {
        return new User(
          highLowToUuid(id.highBits, id.lowBits),
          username,
          typeof obj.displayName === "string" ? obj.displayName : undefined,
        );
      }
    }
    if (Array.isArray(node)) for (const x of node) stack.push(x);
    else for (const k of Object.keys(obj)) stack.push(obj[k]);
  }
  return null;
}

function serializeFidelius(id: FideliusIdentity): {
  publicKey: string; privateKey: string; identityKeyId: string; rwk: string; version: number;
} {
  return {
    publicKey: bytesToHex(id.cleartextPublicKey),
    privateKey: bytesToHex(id.cleartextPrivateKey),
    identityKeyId: bytesToHex(id.identityKeyId),
    rwk: bytesToHex(id.rwk),
    version: id.version,
  };
}

function deserializeFidelius(blob: {
  publicKey: string; privateKey: string; identityKeyId: string; rwk: string; version: number;
}): FideliusIdentity {
  return {
    cleartextPublicKey: hexToBytes(blob.publicKey),
    cleartextPrivateKey: hexToBytes(blob.privateKey),
    identityKeyId: hexToBytes(blob.identityKeyId),
    rwk: hexToBytes(blob.rwk),
    version: blob.version,
  };
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex length ${s.length} not even`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
