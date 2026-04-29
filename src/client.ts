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
import { listFriends, type RawSyncFriendData } from "./api/friends.ts";
import { addFriends } from "./api/friending.ts";
import { searchUsers } from "./api/search.ts";
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
import { callRpc, type GrpcMethodDesc } from "./transport/grpc-web.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export type SnapcapAuthBlob = {
  /** Serialized tough-cookie jar (jar.toJSON()). */
  jar: object;
  /** Most recent bearer (may be expired; refresh-on-401 will re-mint). */
  bearer: string;
  /** UA fingerprint we used at login — keep for consistency on subsequent calls. */
  userAgent: string;
  /** Cached self user (saves a round-trip on rehydrate). */
  self?: { userId: string; username?: string; displayName?: string };
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

  private constructor(jar: CookieJar, bearer: string, userAgent: string, self?: User) {
    this.jar = jar;
    this.bearer = bearer;
    this.userAgent = userAgent;
    this.self = self;
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
    return client;
  }

  static async fromAuth(opts: FromAuthOpts): Promise<SnapcapClient> {
    const jar = await CookieJar.deserialize(opts.auth.jar as never);
    const self = opts.auth.self
      ? new User(opts.auth.self.userId, opts.auth.self.username, opts.auth.self.displayName)
      : undefined;
    return new SnapcapClient(jar, opts.auth.bearer, opts.auth.userAgent, self);
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
    const friends = await this.listFriends() as Record<string, unknown>;
    const found = findSelf(friends, username);
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
    };
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

  async listFriends(): Promise<RawSyncFriendData> {
    return await listFriends(this.makeRpc());
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

  /** Build an `rpc.unary` impl bound to this client's jar/bearer/refresh. */
  private makeRpc(): {
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
