/**
 * SnapcapClient — main entry point.
 *
 * Constructed with a `DataStore` (required) plus optional cold-start
 * credentials. The DataStore is the canonical persistence backbone:
 * cookies, bearer, Fidelius identity, and the Snap-bundle's own
 * sandbox storage (`local_*` / `session_*` / `indexdb_*`) all live
 * there under stable keys.
 *
 *   const client = new SnapcapClient({ dataStore, username, password });
 *   if (await client.isAuthorized()) {
 *     const friends = await client.listFriends();
 *   }
 *
 * `isAuthorized()` decides whether we already have valid restored
 * cookies, runs the full native login if not (and credentials are
 * present), and caches a positive result in-memory so subsequent
 * calls are free. Pass `{ force: true }` to re-login even if warm.
 *
 * `logout()` deletes only the auth-state keys (`cookie_jar`,
 * `session_snapcap_bearer`, `fidelius`) — other sandbox storage entries
 * (the bundle's own `local_*` / `session_*` / `indexdb_*`) are left
 * intact since the SDK doesn't own them.
 *
 * Two layers of API:
 *   - Low-level primitives — take IDs, return Promises. Useful when you
 *     already have an ID from a DB/URL/webhook.
 *   - Domain objects (Conversation, User) — wrap the primitives with
 *     ergonomic methods. Returned by the high-level helpers
 *     (`getConversations()`, `conversation()`).
 */
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
import { installShims, getSandbox } from "./shims/runtime.ts";
import type { DataStore } from "./storage/data-store.ts";
import { CookieJarStore } from "./storage/cookie-store.ts";
import { idbGet, idbPut, idbDelete } from "./storage/idb-utils.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/**
 * IndexedDB coordinates for the serialized Fidelius identity blob.
 * Lands in the DataStore under `indexdb_snapcap__fidelius__identity`
 * via the IDB shim — never reach for `dataStore.get/set` directly here.
 */
const FIDELIUS_DB = "snapcap";
const FIDELIUS_STORE = "fidelius";
const FIDELIUS_KEY = "identity";

/**
 * Serialized form of a Fidelius identity stored under the `fidelius`
 * DataStore key. Bytes are hex-encoded so the blob is plain JSON.
 *
 * SECURITY: `privateKey` is the long-lived root of E2E encryption for
 * this account. Snap's server never sees it; if you lose this blob the
 * identity can't be recovered (Snap won't let the same user register
 * a second one). Treat the entry as credential-grade.
 */
export type FideliusIdentityBlob = {
  publicKey: string;     // hex (65 bytes, 0x04-prefixed P-256)
  privateKey: string;    // hex (32 bytes)
  identityKeyId: string; // hex (32 bytes)
  rwk: string;           // hex (16 bytes)
  version: number;
};

/**
 * Public constructor options for `SnapcapClient`.
 *
 * The DataStore is required and acts as the canonical persistence
 * backbone — cookies, bearer, Fidelius identity, and the Snap-bundle's
 * own `local_*`/`session_*`/`indexdb_*` sandbox storage all share it.
 *
 * `username`/`password` are only consulted on cold start (no restored
 * cookies). They are NOT persisted to the DataStore — pass them again
 * on subsequent process boots if you want to be able to recover from
 * a session expiry.
 */
export type SnapcapClientOpts = {
  dataStore: DataStore;
  username?: string;
  password?: string;
  /** UA fingerprint used at login. Persists with the cookies for consistency. */
  userAgent?: string;
};

export class SnapcapClient {
  private readonly dataStore: DataStore;
  private readonly creds: LoginCredentials | null;
  private readonly userAgent: string;

  /** Lazy: loaded from the DataStore on first auth-state access. */
  private cookieStore: CookieJarStore | null = null;
  /** Lazy: loaded from the DataStore on first auth-state access; minted on login / 401. */
  private bearer: string | null = null;
  /** Cached "we're warm" flag — `isAuthorized()` returns it short-circuit. */
  private authorized = false;

  /**
   * The logged-in user. Populated automatically when the SDK can derive it
   * (currently from the post-login SyncFriendData walk); otherwise the
   * consumer should set it via `setSelf()` before calling Conversation
   * methods.
   *
   * Auto-discovery from a self-info RPC is tracked separately (see
   * task #50 in the project notes).
   */
  public self?: User;

  /**
   * Long-lived Fidelius E2E identity for this account. Loaded from the
   * DataStore on demand or minted on first login. Required for sending
   * snaps and reading inbound message bodies.
   */
  public fidelius?: FideliusIdentity;

  constructor(opts: SnapcapClientOpts) {
    this.dataStore = opts.dataStore;
    this.creds = opts.username && opts.password
      ? { username: opts.username, password: opts.password }
      : null;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    // Seed the shim singleton with the consumer's DataStore eagerly.
    // `installShims` is first-call-wins — kameleon boot inside the
    // login flow will otherwise win the race with no dataStore set,
    // which means Snap-bundle local/session/indexdb writes go to
    // happy-dom's in-memory defaults instead of our store.
    installShims({ url: "https://www.snapchat.com/web", dataStore: this.dataStore });
  }

  /**
   * Resolve whether this client has a usable session. Three cases:
   *
   *   - Restored cookies + bearer present in the DataStore → true (no network).
   *   - No cookies but credentials supplied → run full login, persist, true.
   *   - No cookies, no creds → false.
   *   - Server rejects the supplied creds → false (does not throw).
   *
   * The first positive result is cached in-memory so subsequent calls are
   * free. Pass `{ force: true }` to bypass the cache and re-login even when
   * already warm.
   */
  async isAuthorized(opts?: { force?: boolean }): Promise<boolean> {
    if (this.authorized && !opts?.force) return true;

    await this.ensureCookieStore();
    if (!opts?.force) {
      // Try restored state first.
      const restoredBearer = await this.loadBearer();
      const haveAuthCookie = await this.haveSessionCookie();
      if (restoredBearer && haveAuthCookie) {
        this.bearer = restoredBearer;
        await this.loadFideliusIfPresent();
        this.loadSelf();
        this.authorized = true;
        return true;
      }
    }

    if (!this.creds) {
      // Nothing to fall back on.
      return false;
    }

    try {
      await this.loginFromCredentials();
      this.authorized = true;
      return true;
    } catch (err) {
      if (process.env.SNAPCAP_TRACE_AUTH) {
        process.stderr.write(`[isAuthorized] loginFromCredentials threw: ${(err as Error).stack ?? err}\n`);
      }
      // Server rejection / network blip / cookie wall — consumer decides
      // what to do with `false`. Throwing here would punish callers that
      // legitimately want to probe authorization state.
      return false;
    }
  }

  /**
   * Clear the auth-state keys (`cookie_jar`, `session_snapcap_bearer`,
   * `indexdb_snapcap__fidelius__identity`) from the DataStore. The
   * bundle's own sandbox storage (other `local_*` / `session_*` /
   * `indexdb_*` entries we don't own) is left intact — wiping it would
   * force the next `isAuthorized()` to re-bootstrap Fidelius WASM state
   * from scratch.
   */
  async logout(): Promise<void> {
    await this.dataStore.delete("cookie_jar");
    const ss = getSandbox().getGlobal<Storage>("sessionStorage");
    ss?.removeItem("snapcap_bearer");
    const ls = getSandbox().getGlobal<Storage>("localStorage");
    ls?.removeItem("snapcap_self");
    await idbDelete(FIDELIUS_DB, FIDELIUS_STORE, FIDELIUS_KEY);
    this.cookieStore = null;
    this.bearer = null;
    this.fidelius = undefined;
    this.self = undefined;
    this.authorized = false;
  }

  /**
   * Override the self-user. Auto-discovery covers the typical case
   * (`isAuthorized` walks SyncFriendData and finds the logged-in
   * user's own metadata), so this is mostly an escape hatch for callers
   * with an out-of-band record of who they're logged in as.
   */
  setSelf(user: User): void {
    this.self = user;
  }

  /**
   * Resolve the logged-in user from server-side data. Calls SyncFriendData
   * (which embeds the caller's own user record alongside the friend list)
   * and matches on `mutableUsername`. Sets `this.self` and returns it.
   */
  async resolveSelf(username: string): Promise<User> {
    const raw = await syncFriendDataRaw(this.makeRpc());
    const found = findSelf(raw, username);
    if (!found) {
      throw new Error(`could not resolve self user "${username}" from SyncFriendData response`);
    }
    this.self = found;
    return found;
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
        const { jar, bearer } = await this.requireAuthState();
        const dx = await connectDuplex({ bearer, jar: jar.jar, userAgent: this.userAgent });
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
      throw new Error("publishPresence requires client.self — call resolveSelf() or isAuthorized() first");
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
      const store = await this.ensureCookieStore();
      const { bearer } = await mintBearer({ jar: store, userAgent: this.userAgent });
      this.bearer = bearer;
      await this.persistBearer(bearer);
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
   * Post an image to MY_STORY (the user's own story feed). Requires
   * `client.self.username`.
   */
  async postStory(bytes: Uint8Array, opts?: { skipNormalize?: boolean }): Promise<void> {
    if (!this.self?.username) {
      throw new Error("postStory requires self.username — call isAuthorized() or resolveSelf() first");
    }
    const { postStory } = await import("./api/media.ts");
    const { nativeFetch } = await import("./transport/native-fetch.ts");
    await postStory(this.makeRpc(), nativeFetch, this.self.userId, this.self.username, {
      bytes, skipNormalize: opts?.skipNormalize,
    });
  }

  /** Fetch recent messages for a conversation. */
  async fetchMessages(conversationId: string, opts?: { limit?: number; secondary?: number }): Promise<QueryMessagesResponse> {
    if (!this.self?.userId) {
      throw new Error("fetchMessages requires self.userId — call resolveSelf() or isAuthorized() first");
    }
    return await queryMessages(this.makeRpc(), {
      conversationId,
      selfUserId: this.self.userId,
      limit: opts?.limit,
      secondary: opts?.secondary,
    });
  }

  /** Search Snap's user index by query string. */
  async searchUsers(query: string, pageSize?: number): Promise<User[]> {
    const { jar, bearer } = await this.requireAuthState();
    return await searchUsers(query, {
      jar,
      userAgent: this.userAgent,
      bearer,
      refreshBearer: () => this.refreshBearer(),
    }, pageSize);
  }

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
   * call routed through this rpc instance (e.g. Fidelius's gateway 401s
   * if Origin/Referer are present, so its API module strips them).
   */
  makeRpc(transformHeaders?: HeaderTransform): {
    unary: (
      method: GrpcMethodDesc<unknown, unknown>,
      request: unknown,
    ) => Promise<unknown>;
  } {
    return {
      unary: async (method, request) => {
        const { jar, bearer } = await this.requireAuthState();
        return await callRpc({
          method,
          request,
          host: "https://web.snapchat.com",
          jar,
          userAgent: this.userAgent,
          bearer,
          refreshBearer: () => this.refreshBearer(),
          origin: "https://www.snapchat.com",
          referer: "https://www.snapchat.com/",
          transformHeaders,
        });
      },
    };
  }

  // ── Auth-state plumbing ─────────────────────────────────────────────

  /** Lazy-init the cookie store from the DataStore. Idempotent. */
  private async ensureCookieStore(): Promise<CookieJarStore> {
    if (!this.cookieStore) {
      this.cookieStore = await CookieJarStore.create(this.dataStore, "cookie_jar");
    }
    return this.cookieStore;
  }

  /**
   * Read jar + bearer from the (possibly already-loaded) DataStore-backed
   * state. Used by every RPC method to make sure we have something to send.
   */
  private async requireAuthState(): Promise<{ jar: CookieJarStore; bearer: string }> {
    const jar = await this.ensureCookieStore();
    if (!this.bearer) this.bearer = await this.loadBearer();
    if (!this.bearer) {
      throw new Error(
        "SnapcapClient has no bearer — call client.isAuthorized() and check it returns true before calling RPC methods.",
      );
    }
    return { jar, bearer: this.bearer };
  }

  /** Read cached bearer string via the sandbox's sessionStorage shim. */
  private async loadBearer(): Promise<string | null> {
    const ss = getSandbox().getGlobal<Storage>("sessionStorage");
    const v = ss?.getItem("snapcap_bearer");
    return v ?? null;
  }

  private async persistBearer(token: string): Promise<void> {
    const ss = getSandbox().getGlobal<Storage>("sessionStorage");
    ss?.setItem("snapcap_bearer", token);
  }

  /** Restore the persisted self user, if any. Lands at `local_snapcap_self`. */
  private loadSelf(): void {
    if (this.self) return;
    const ls = getSandbox().getGlobal<Storage>("localStorage");
    const raw = ls?.getItem("snapcap_self");
    if (!raw) return;
    try {
      const j = JSON.parse(raw) as { userId: string; username?: string; displayName?: string };
      if (j?.userId) this.self = new User(j.userId, j.username, j.displayName);
    } catch {
      // corrupt — drop it; next cold login will repopulate
    }
  }

  /** Persist the current self user. */
  private persistSelf(): void {
    if (!this.self) return;
    const ls = getSandbox().getGlobal<Storage>("localStorage");
    ls?.setItem("snapcap_self", JSON.stringify(this.self.toJSON()));
  }

  /**
   * Quick check: does the cookie jar have a session cookie that's
   * plausibly still valid? `__Host-sc-a-auth-session` is the long-lived
   * refresh-style cookie that login deposits — if it's gone, the bearer
   * is unusable too.
   */
  private async haveSessionCookie(): Promise<boolean> {
    const store = await this.ensureCookieStore();
    const cookies = await store.jar.getCookies("https://accounts.snapchat.com");
    return cookies.some((c) => c.key === "__Host-sc-a-auth-session");
  }

  /**
   * Restore a previously-minted Fidelius identity, if any. Reads through
   * the IDB shim — lands in the DataStore at
   * `indexdb_snapcap__fidelius__identity`.
   */
  private async loadFideliusIfPresent(): Promise<void> {
    if (this.fidelius) return;
    try {
      const blob = await idbGet<FideliusIdentityBlob>(FIDELIUS_DB, FIDELIUS_STORE, FIDELIUS_KEY);
      if (!blob) return;
      this.fidelius = deserializeFidelius(blob);
    } catch {
      // Corrupt blob / IDB error — ignore; next login will mint a fresh
      // one if the server still considers us un-registered, otherwise
      // E2E ops will remain unavailable.
    }
  }

  /** Persist the current Fidelius identity via the IDB shim. */
  private async persistFidelius(identity: FideliusIdentity): Promise<void> {
    const blob = serializeFidelius(identity);
    await idbPut(FIDELIUS_DB, FIDELIUS_STORE, FIDELIUS_KEY, blob);
  }

  /**
   * Run the full native-login flow: kameleon → WebLoginService 2-step →
   * SSO bearer → cookie seed → SyncFriendData self-resolve →
   * Fidelius identity mint+register. Persists everything to the DataStore.
   */
  private async loginFromCredentials(): Promise<void> {
    if (!this.creds) {
      throw new Error("loginFromCredentials called without credentials");
    }
    const store = await this.ensureCookieStore();
    await nativeLogin({ credentials: this.creds, jar: store, userAgent: this.userAgent });
    const { bearer } = await mintBearer({ jar: store, userAgent: this.userAgent });
    this.bearer = bearer;
    await store.flush();
    await this.persistBearer(bearer);

    // Auto-discover self user. SyncFriendData embeds the logged-in user's
    // own metadata alongside the friend list — we just have to walk it.
    // Best-effort: if discovery fails, leave self unset and let the caller
    // call setSelf() manually.
    try {
      await this.resolveSelf(this.creds.username);
      this.persistSelf();
    } catch {
      // tolerate — consumer can still operate via setSelf()
    }

    // Fidelius: prefer a previously-persisted identity; otherwise mint
    // and register. If the server says "already registered" (401), surface
    // a warning and continue without E2E.
    await this.loadFideliusIfPresent();
    if (!this.fidelius) {
      try {
        const identity = await mintFideliusIdentity();
        const fideliusRpc = this.makeRpc(stripOriginReferer);
        await initializeWebKey(fideliusRpc, identity);
        this.fidelius = identity;
        await this.persistFidelius(identity);
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
    }
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

function serializeFidelius(id: FideliusIdentity): FideliusIdentityBlob {
  return {
    publicKey: bytesToHex(id.cleartextPublicKey),
    privateKey: bytesToHex(id.cleartextPrivateKey),
    identityKeyId: bytesToHex(id.identityKeyId),
    rwk: bytesToHex(id.rwk),
    version: id.version,
  };
}

function deserializeFidelius(blob: FideliusIdentityBlob): FideliusIdentity {
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
