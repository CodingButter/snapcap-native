/**
 * Chat-bundle Zustand store shapes — module 94704 hosts the WHOLE
 * chat-bundle state. This file declares the store envelope, the slice
 * union the SDK currently reads (`auth`, `user`, `presence`, `messaging`),
 * and the user-facing record types stored inside the `user` slice.
 *
 * `PresenceSlice` lives in its sibling `./presence.ts` file because the
 * presence shape pulls in {@link BundlePresenceSession} which has its
 * own nontrivial action vocabulary; the cross-import here is one-way
 * (chat-store imports presence, not the other way round).
 */
import type { PresenceSlice } from "./presence.ts";

/**
 * Raw Zustand store shape — module 94704 hosts the WHOLE chat-bundle state
 * (auth + user + presence + talk + more). Per Phase 1B empirical finding the
 * bundle uses plain Zustand v4 (no `subscribeWithSelector` middleware), so
 * `subscribe` is a single-argument listener of the form
 * `(state, prev) => void`. Returns an unsubscribe thunk.
 *
 * `T` defaults to `ChatState` — the slice union the SDK currently reads.
 * Callers that need a slice not in `ChatState` can re-parameterize.
 *
 * @internal Bundle wire-format type.
 */
export interface ChatStore<T = ChatState> {
  getState(): T;
  setState(updater: ((s: T) => Partial<T>) | Partial<T>): void;
  subscribe(listener: (state: T, prev: T) => void): () => void;
  destroy?(): void;
}

/**
 * Slice union the SDK currently reads off the chat-bundle Zustand store.
 * Add slices here only when an api file actually needs them — speculative
 * keys hide schema drift.
 *
 * @internal Bundle wire-format type.
 */
export interface ChatState {
  auth: AuthSlice;
  user: UserSlice;
  presence: PresenceSlice;
  messaging: MessagingSlice;
}

/**
 * `state.messaging` slice on the bundle's Zustand store — module 94704
 * (factory in chat main byte ~6604846, beginning `messaging:{client:void 0,…`).
 *
 * Holds the per-conversation cache the bundle's reducers + selectors read
 * from. Critically, the presence slice's `createPresenceSession` ends up
 * `await firstValueFrom(observeConversationParticipants$)` inside the
 * `PresenceServiceImpl` — that observable only emits when the target conv
 * is present in `state.messaging.conversations` (selector `mt.VN(state,
 * convIdStr)` reads `state.messaging.conversations[convIdStr]?.participants`).
 *
 * Without React running the bundle's normal feed-pump, the slice is
 * empty, the selector emits nothing, and `createPresenceSession` hangs
 * forever. Callers (see {@link Messaging.setTyping} →
 * `#ensurePresenceForConv`) prime by invoking
 * `messagingSlice.fetchConversation(envelope)` BEFORE
 * `createPresenceSession` — that action drives `S.ik(session, convRef)`
 * (= `convMgr.fetchConversation`) and writes the result via
 * `(0,fr.wD)(r, e.messaging.conversations)`, populating the
 * participants payload the presence selector waits on.
 *
 * Only the fields the SDK currently reads / drives are typed; tail keys
 * (`feed`, `lightboxActiveConversations`, `client`, etc.) are intentionally
 * omitted — add them when an api file actually needs one.
 *
 * @internal Bundle wire-format type.
 */
export interface MessagingSlice {
  /**
   * Conversation cache keyed by hyphenated conv UUID string. Each entry
   * carries the bundle-realm `Conversation` record (with `.participants`)
   * the presence slice's `observeConversationParticipants$` observable
   * reads from. Values typed as `unknown` because the SDK doesn't decode
   * the inner shape — the only contract we need is "the key exists,
   * with a participants payload."
   */
  conversations: Record<string, unknown>;
  /**
   * Drive `convMgr.fetchConversation(convRef)` and write the result back
   * into the `conversations` cache via the slice's internal `(0,fr.wD)`
   * merge. Resolves with the bundle-realm `Conversation` record. Accepts
   * the same `{id: Uint8Array(16), str: hyphenated-uuid}` envelope shape
   * the rest of the messaging surface uses.
   */
  fetchConversation: (convEnvelope: { id: Uint8Array; str: string }) => Promise<unknown>;
}

/**
 * `state.auth` slice on the bundle's Zustand store — module 94704.
 *
 * @internal Bundle wire-format type.
 */
export interface AuthSlice {
  initialize(loc: { hash: string; search: string }): Promise<void>;
  logout(force?: boolean): Promise<void>;
  refreshToken(reason: string, attestation?: string): Promise<void>;
  /** `state.auth.fetchToken({reason})` — used by the SPA's PageLoad path. */
  fetchToken?: (opts: { reason: string }) => Promise<unknown>;
}

/**
 * Snake-cased record stored in `state.user.publicUsers`. Populated by
 * Snap's own SPA paths that touch this cache (search results,
 * SyncFriendData side-effects); `GetSnapchatterPublicInfo` itself does
 * NOT auto write-back here — its response shape is the camel-cased
 * {@link SnapchatterPublicInfo} delivered to the immediate caller.
 *
 * @internal Bundle wire-format type.
 */
export interface PublicUserRecord {
  user_id?: string;
  username?: string;
  display_name?: string;
  mutable_username?: string;
}

/**
 * Camel-cased Snapchatter record returned in
 * `GetSnapchatterPublicInfo({snapchatters: [...]})`. Field set captured
 * from the chat-bundle Atlas module's response default (`function $`).
 * Bundle keeps `userId` as `Uint8Array(16)` — convert via `bytesToUuid`
 * before exposing to consumers.
 *
 * Distinct from {@link PublicUserRecord} (snake-cased, lives in
 * `state.user.publicUsers`). `GetSnapchatterPublicInfo` does NOT
 * write-back into that cache — its caller receives this shape directly.
 * Nested envelopes (`bitmojiPublicInfo`, `profileLogo`,
 * `creatorSubscriptionProductsInfo`) stay typed as `unknown` so schema
 * drift surfaces as a typed `unknown` rather than a stale concrete
 * shape; the api layer ({@link User} / {@link BitmojiPublicInfo})
 * provides the consumer-facing types.
 *
 * @remarks
 * Index signature (`[k: string]: unknown`) carries any future fields
 * Snap adds without forcing an SDK update — same forward-compat posture
 * as {@link User}'s tail.
 *
 * @internal Bundle wire-format type.
 */
export interface SnapchatterPublicInfo {
  userId: Uint8Array;
  username?: string;
  displayName?: string;
  mutableUsername?: string;
  isOfficial?: boolean;
  isPopular?: boolean;
  snapProId?: string;
  profileTier?: number;
  bitmojiPublicInfo?: unknown;
  profileLogo?: unknown;
  creatorSubscriptionProductsInfo?: unknown;
  /** Forward-compat tail — see remarks. */
  [k: string]: unknown;
}

/**
 * Snake-cased record stored in `state.user.incomingFriendRequests`.
 * Populated by `IncomingFriendSync`. Same snake-case rationale as
 * {@link PublicUserRecord}.
 *
 * @internal Bundle wire-format type.
 */
export interface IncomingFriendRequestRecord {
  user_id?: string;
  username?: string;
  display_name?: string;
  mutable_username?: string;
  /** Server-side ms timestamp; bundle stores as number. */
  added_timestamp_ms?: number;
  /** Source attribution — int matching the FriendSource enum. */
  added_by?: number;
}

/**
 * `state.user` slice on the bundle's Zustand store — module 94704.
 *
 * Carries the friend graph (`mutuallyConfirmedFriendIds`), pending requests
 * (`incomingFriendRequests`, `outgoingFriendRequestIds`), and the
 * `publicUsers` cache populated by `GetSnapchatterPublicInfo`. Mutated in
 * place by Immer drafts.
 *
 * Only the fields the SDK currently reads are typed; `[k: string]: unknown`
 * is intentionally omitted so a typo on the consumer side surfaces at
 * compile time rather than silently returning `undefined`.
 *
 * @internal Bundle wire-format type.
 */
export interface UserSlice {
  /** Hyphenated UUIDs of mutual friends (excludes self). */
  mutuallyConfirmedFriendIds: string[];
  /** Hyphenated UUIDs of pending outgoing friend requests. */
  outgoingFriendRequestIds: string[];
  /** `Map<userId, FriendRequestRecord>` — populated by `IncomingFriendSync`. */
  incomingFriendRequests: Map<string, IncomingFriendRequestRecord>;
  /** `Map<userId, PublicUserRecord>` — populated by `GetSnapchatterPublicInfo`. */
  publicUsers?: Map<string, PublicUserRecord>;
  /** Bundle thunk: refresh the friends graph from the server. */
  syncFriends?: () => Promise<void>;
}
