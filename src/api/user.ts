/**
 * User — a Snap account.
 *
 * Currently only `userId` is reliably populated (from SyncConversations
 * participants and from auto-discovery on the logged-in client). `username`
 * and `displayName` come from AtlasGw.GetSnapchatterPublicInfo, which we
 * call lazily when `enrich()` is invoked or when the SDK has the data
 * cheaply available (e.g., from SyncFriendData).
 */
export class User {
  constructor(
    /** 16-byte UUID as a hyphenated string. The canonical identity in Snap's RPC layer. */
    public readonly userId: string,
    public username?: string,
    public displayName?: string,
  ) {}

  toString(): string {
    return this.username ? `${this.username} <${this.userId}>` : this.userId;
  }

  toJSON(): { userId: string; username?: string; displayName?: string } {
    return { userId: this.userId, username: this.username, displayName: this.displayName };
  }
}
