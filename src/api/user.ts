/**
 * User — a Snap account.
 *
 * Constructed in three places:
 *   - `User.fromFriendRecord(rec)` for friends + the logged-in self user
 *     (parses the rich record SyncFriendData returns)
 *   - `User.fromSearchRecord(rec)` for users found via search
 *   - new User(uuid, …)` directly when only the UUID is known
 *
 * The class is light: a handful of canonical fields, and `raw` for power
 * users who need everything Snap returned. Methods stay pure data — any
 * RPCs (sending messages, friending) live on SnapcapClient or Conversation.
 */
import { highLowToUuid } from "../transport/proto-encode.ts";

/**
 * Snap's friend-link state. Enum values mirror the protobuf int but we
 * surface as a string for ergonomics.
 *
 * Captured codes: 2 = mutual, 9 = added-by-them-only (or vice-versa).
 * Other values land as "unknown" until we observe and label them.
 */
export type FriendType = "mutual" | "added" | "added-by-them" | "blocked" | "self" | "unknown";

export type BitmojiInfo = {
  avatarId?: string;
  selfieId?: string;
  sceneId?: string;
  backgroundId?: string;
  backgroundUrl?: string;
  gender?: string;
};

export class User {
  /** 16-byte UUID as a hyphenated string. The canonical identity in Snap's RPCs. */
  public readonly userId: string;

  /** The user's chosen username (mutable_username in Snap's schema). */
  public username?: string;

  /** Display name (often the user's real name). */
  public displayName?: string;

  /** Legacy/system username used by official accounts (e.g. "teamsnapchat"). */
  public legacyUsername?: string;

  /** Friend-graph state with respect to the logged-in user. */
  public friendType?: FriendType;

  /** When the friend was added (server-side ms timestamp). */
  public addedAt?: Date;

  /** Bitmoji avatar metadata. `avatarId` is the primary identifier. */
  public bitmoji?: BitmojiInfo;

  /** True if the logged-in user has muted this friend's story. */
  public isStoryMuted?: boolean;

  /** True if this account has Snapchat+. */
  public isPlusSubscriber?: boolean;

  /** Per-friend emoji set (best-friend, super-bff, etc.). */
  public friendmojis?: unknown[];

  /** Original protobuf-decoded record for callers who need everything else. */
  public raw?: Record<string, unknown>;

  constructor(userId: string, username?: string, displayName?: string) {
    this.userId = userId;
    this.username = username;
    this.displayName = displayName;
  }

  /**
   * Parse a record from a SyncFriendData response (friends list) into a User.
   * The same shape covers the logged-in user's own self-record.
   */
  static fromFriendRecord(rec: Record<string, unknown>): User | null {
    const idObj = rec["userId"] as { highBits?: bigint | string; lowBits?: bigint | string } | undefined;
    if (!idObj || idObj.highBits === undefined || idObj.lowBits === undefined) return null;
    const u = new User(highLowToUuid(idObj.highBits, idObj.lowBits));
    u.username = pickString(rec, "mutableUsername");
    u.displayName = pickString(rec, "displayName");
    u.legacyUsername = pickString(rec, "legacyUsername");
    u.friendType = mapFriendLinkType(pickNumber(rec, "friendLinkType"));
    const addedTs = pickString(rec, "addedTs");
    if (addedTs && addedTs !== "0") u.addedAt = new Date(Number(addedTs));
    u.bitmoji = pickBitmoji(rec);
    u.isStoryMuted = pickBoolean(rec, "isStoryMuted");
    u.isPlusSubscriber = pickBoolean(rec, "isPlusSubscriber");
    const fm = rec["friendmojis"];
    if (Array.isArray(fm)) u.friendmojis = fm;
    u.raw = rec;
    return u;
  }

  /**
   * Parse a record from a /search/search response (search results) into a User.
   * Uses a different shape than friend records (UUIDs are strings here).
   */
  static fromSearchRecord(rec: { userId: string; username?: string; displayName?: string }): User {
    return new User(rec.userId, rec.username, rec.displayName);
  }

  toString(): string {
    return this.username ? `${this.username} <${this.userId}>` : this.userId;
  }

  toJSON(): { userId: string; username?: string; displayName?: string } {
    return {
      userId: this.userId,
      username: this.username,
      displayName: this.displayName,
    };
  }
}

function pickString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function pickNumber(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === "number" ? v : undefined;
}
function pickBoolean(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key];
  return typeof v === "boolean" ? v : undefined;
}
function pickBitmoji(rec: Record<string, unknown>): BitmojiInfo | undefined {
  const avatarId = pickString(rec, "bitmojiAvatarId");
  const selfieId = pickString(rec, "bitmojiSelfieId");
  const sceneId = pickString(rec, "bitmojiSceneId");
  const backgroundId = pickString(rec, "bitmojiBackgroundId");
  const bg = rec["bitmojiBackgroundUrl"] as { backgroundUrl?: string } | undefined;
  const meta = rec["bitmojiAvatarMetadata"] as { gender?: string } | undefined;
  if (!avatarId && !selfieId && !sceneId && !backgroundId && !bg && !meta) return undefined;
  return {
    avatarId,
    selfieId,
    sceneId,
    backgroundId,
    backgroundUrl: bg?.backgroundUrl,
    gender: meta?.gender,
  };
}

function mapFriendLinkType(code: number | undefined): FriendType {
  switch (code) {
    case 2: return "mutual";
    case 9: return "added-by-them";
    case 1: return "self";
    case 3: return "blocked";
    case 4: return "added";
    default: return "unknown";
  }
}
