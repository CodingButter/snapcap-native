# SnapcapClient

The main entry point. Constructed once per account, holds the cookie jar, bearer, Fidelius identity, and `self` user.

```ts
import { SnapcapClient, FileDataStore } from "@snapcap/native";

const client = new SnapcapClient({
  dataStore: new FileDataStore("./auth.json"),
  username: process.env.SNAP_USER,
  password: process.env.SNAP_PASS,
});
```

## Constructor

```ts
new SnapcapClient(opts: SnapcapClientOpts)
```

```ts
type SnapcapClientOpts = {
  /** Persistent backing for cookies, bearer, Fidelius identity, and bundle storage. Required. */
  dataStore: DataStore;
  /** Cold-start username. Only used if the DataStore is empty/expired. NOT persisted. */
  username?: string;
  /** Cold-start password. Only used if the DataStore is empty/expired. NOT persisted. */
  password?: string;
  /** UA fingerprint used at login. Defaults to a Linux Chrome 147 string. */
  userAgent?: string;
};
```

The constructor is synchronous: it just wires the DataStore into the sandbox shims via `installShims`. No network and no disk I/O beyond loading the DataStore file. All real work happens in `isAuthorized()`.

`username`/`password` are only consulted when `isAuthorized()` decides a fresh login is needed. They are **not** written to the DataStore; pass them on every boot if you want automatic recovery from session expiry.

## Public fields

```ts
public self?: User;
```

The logged-in user. Auto-populated by `isAuthorized()` when it runs a fresh login (via `resolveSelf`) or restored from `local_snapcap_self` on a warm start. Set manually with `setSelf(user)` if you need to bypass the discovery walk.

```ts
public fidelius?: FideliusIdentity;
```

Long-lived E2E identity. Loaded from `indexdb_snapcap__fidelius__identity` on warm starts; minted + registered on cold start. Required for sending snaps and decrypting inbound message bodies.

## Auth methods

### isAuthorized

```ts
isAuthorized(opts?: { force?: boolean }): Promise<boolean>
```

Resolve whether the client has a usable session. See [auth model](/guide/auth) for the full decision flow. Idempotent and cached — repeat calls are free.

- **Restored cookies + bearer present** → true (no network).
- **Cookies missing + creds set** → run full login, persist, return true.
- **Cookies missing + no creds** → false.
- **Server rejects creds** → false (does **not** throw).

Pass `{ force: true }` to bypass the cache and re-login even when warm.

### logout

```ts
logout(): Promise<void>
```

Clear `cookie_jar`, `session_snapcap_bearer`, `local_snapcap_self`, and `indexdb_snapcap__fidelius__identity` from the DataStore. Other bundle-owned `local_*` / `session_*` / `indexdb_*` keys are left intact.

> Wiping Fidelius is destructive: Snap won't let the same user re-register a fresh identity, so E2E becomes unavailable from this client. Only call this if you're done with the account or you have the original Fidelius blob backed up.

### setSelf

```ts
setSelf(user: User): void
```

Override `client.self`. Mostly an escape hatch for callers that already know who they're logged in as.

### resolveSelf

```ts
resolveSelf(username: string): Promise<User>
```

Resolve the self-user from `SyncFriendData` (which embeds the caller's own record alongside the friend list). Sets `client.self` and returns it. Throws if `username` isn't found in the response.

## Conversation methods

### getConversations

```ts
getConversations(): Promise<Conversation[]>
```

Fetch the list of conversations the logged-in user is in. Returns `Conversation` instances bound to this client. Requires `client.self` (call `isAuthorized()` first).

### conversation

```ts
conversation(conversationId: string, participantUserIds?: string[]): Conversation
```

Build a `Conversation` handle for a known conversation ID without round-tripping `SyncConversations`. Useful when you've persisted IDs in your own DB. Pass `participantUserIds` if you need `setTyping` / `markViewed` (they require knowing the peer).

```ts
const chat = client.conversation(persistedId, [client.self.userId, peerUserId]);
await chat.sendText("hi");
```

## Friend methods

### listFriends

```ts
listFriends(): Promise<User[]>
```

Fetch the logged-in user's friend list via AtlasGw `SyncFriendData`. Each `User` includes username, display name, friend-link state, bitmoji, and the raw record.

### addFriend

```ts
addFriend(userId: string | string[], source?: string): Promise<void>
```

Send a friend request to one or more users. `source` defaults to `"dweb_add_friend"` (what the web client sends from a search result). Pass an array to add multiple in one RPC.

### searchUsers

```ts
searchUsers(query: string, pageSize?: number): Promise<User[]>
```

Search Snap's user index by query string. `pageSize` defaults to 20 (the value web sends). The SDK doesn't paginate — re-issue with the next batch yourself if needed.

## Story

### postStory

```ts
postStory(bytes: Uint8Array, opts?: { skipNormalize?: boolean }): Promise<void>
```

Post an image to the user's `MY_STORY`. By default the bytes are auto-normalised to 1080×1920 RGBA PNG (Snap rejects other layouts on this endpoint). Pass `skipNormalize: true` if your image is already in the exact required shape. Requires `client.self.username`.

## Messaging primitives

These take raw IDs — useful when you've stored IDs in a DB and want to skip the `Conversation` wrapper. For most flows, prefer the `Conversation` methods.

### fetchMessages

```ts
fetchMessages(
  conversationId: string,
  opts?: { limit?: number; secondary?: number },
): Promise<QueryMessagesResponse>
```

Fetch recent messages for a conversation. Returns `{ raw: Uint8Array }` — caller is responsible for decoding the proto for now (typed decoder lands once we have a non-empty E2E test capture).

### sendTypingNotification

```ts
sendTypingNotification(
  conversationId: string,
  userId: string,
  typingType?: number,    // defaults to TypingActivity.TEXT (6)
): Promise<void>
```

Send the gRPC typing notification. Note: the gRPC variant is accepted by the server but does **not** fan out to recipients. For real "typing…" indicators, use `Conversation.setTyping()` (which routes over the duplex WS).

### updateConversationView

```ts
updateConversationView(
  conversationId: string,
  userId: string,
  state?: number,         // defaults to ConversationViewState.ACTIVE (10)
): Promise<void>
```

Update conversation view-state. Same caveat as above — for real "in chat" indicators, use `Conversation.markViewed()`.

### markMessageViewed

```ts
markMessageViewed(
  messageId: bigint,
  conversationId: string,
  userId: string,
  action?: number,        // defaults to 15
): Promise<void>
```

Mark a single received message as viewed.

## Low-level RPC

### rpc (getter)

```ts
get rpc: { unary(method: GrpcMethodDesc, request: unknown): Promise<unknown> }
```

A lazily-built `rpc.unary` impl bound to this client's jar/bearer/refresh. Shorthand for `client.makeRpc()`.

### makeRpc

```ts
makeRpc(transformHeaders?: HeaderTransform): {
  unary: (method: GrpcMethodDesc<unknown, unknown>, request: unknown) => Promise<unknown>;
};
```

Build a fresh `rpc.unary` impl, optionally applying a header-mutation hook to every call. Used internally for surfaces with header peculiarities (e.g. Fidelius's gateway 401s if `Origin`/`Referer` are present, so `initializeWebKey` strips them).

```ts
const stripped = client.makeRpc((h) => {
  delete h["origin"];
  delete h["referer"];
  return h;
});
await someApiCall(stripped, ...);
```

`HeaderTransform` is `(headers: Record<string, string>) => Record<string, string>`.

## Types

### FideliusIdentityBlob

```ts
type FideliusIdentityBlob = {
  publicKey: string;     // hex (65 bytes, 0x04-prefixed P-256)
  privateKey: string;    // hex (32 bytes)
  identityKeyId: string; // hex (32 bytes)
  rwk: string;           // hex (16 bytes)
  version: number;
};
```

Serialised form of a Fidelius identity. Lands at `indexdb_snapcap__fidelius__identity` in the DataStore. Treat as credential-grade — losing it means losing E2E for the account.
