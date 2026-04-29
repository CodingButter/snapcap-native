# User

A Snap account. Lightweight data class — methods stay pure data, any RPCs (sending messages, friending) live on `SnapcapClient` or `Conversation`.

## Constructor

```ts
new User(userId: string, username?: string, displayName?: string)
```

Direct construction when you only have the UUID (e.g. `client.conversation(id, [participantUserIds])`).

## Fields

```ts
public readonly userId: string;        // 16-byte UUID, hyphenated
public username?: string;              // chosen username (mutable_username)
public displayName?: string;           // often the user's real name
public legacyUsername?: string;        // legacy/system username (e.g. "teamsnapchat")
public friendType?: FriendType;        // friend-graph state
public addedAt?: Date;                 // when added (server-side ms timestamp)
public bitmoji?: BitmojiInfo;          // bitmoji metadata
public isStoryMuted?: boolean;
public isPlusSubscriber?: boolean;     // Snapchat+
public friendmojis?: unknown[];        // per-friend emoji set
public raw?: Record<string, unknown>;  // original protobuf-decoded record
```

## Types

```ts
type FriendType = "mutual" | "added" | "added-by-them" | "blocked" | "self" | "unknown";

type BitmojiInfo = {
  avatarId?: string;
  selfieId?: string;
  sceneId?: string;
  backgroundId?: string;
  backgroundUrl?: string;
  gender?: string;
};
```

`friendType` is mapped from Snap's protobuf enum: `2 → mutual`, `9 → added-by-them`, `1 → self`, `3 → blocked`, `4 → added`, anything else → `"unknown"`. If you're seeing `"unknown"` consistently for a state you care about, check the raw record and open an issue.

## Static methods

### fromFriendRecord

```ts
static fromFriendRecord(rec: Record<string, unknown>): User | null
```

Parse a record from a `SyncFriendData` response (friends list) into a `User`. The same shape covers the logged-in user's own self-record. Returns `null` if `userId.highBits` / `userId.lowBits` is missing.

### fromSearchRecord

```ts
static fromSearchRecord(rec: { userId: string; username?: string; displayName?: string }): User
```

Parse a record from a `/search/search` response (search results). Search uses string UUIDs directly, unlike friend records.

## Instance methods

### toString

```ts
toString(): string
```

`"username <userId>"` if username is known, otherwise just the UUID.

### toJSON

```ts
toJSON(): { userId: string; username?: string; displayName?: string }
```

Stable subset — what gets serialised to `local_snapcap_self` in the DataStore.

## FriendAction

The action enum used by `client.addFriend()` under the hood. Surfaced for callers who want to call into the lower-level `addFriends()` helper directly.

```ts
export const FriendAction = {
  ADD: 2,
} as const;
```

Other values (REMOVE, BLOCK) likely exist on the server but aren't reverse-engineered yet.
