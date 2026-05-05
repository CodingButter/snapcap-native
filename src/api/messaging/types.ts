/**
 * Public messaging value types — surfaced to consumers via the
 * `Messaging` manager and the top-level `index.ts` re-exports.
 *
 * Pure shape declarations; no runtime imports beyond `Uint8Array`.
 */

/** Per-conversation summary returned by `Messaging.listConversations`. */
export interface ConversationSummary {
  /** Hyphenated UUID. */
  conversationId: string;
  /** Conversation kind code from MCS — 5 = DM, 13 = group, 420 = MOB friends, etc. */
  type: number;
  /** Hyphenated UUIDs of all participants (includes self). */
  participants: string[];
}

/** One message envelope as captured from BatchDeltaSync. */
export interface RawEncryptedMessage {
  /** Conversation this message belongs to. */
  conversationId: string;
  /** Sender's hyphenated UUID. */
  senderUserId: string;
  /** Server message id (varint). */
  messageId: bigint;
  /** Server timestamp (ms since epoch). */
  serverTimestampMs: bigint;
  /**
   * Raw envelope bytes — the `f3` ContentEnvelope on the ContentMessage
   * proto. Includes the FideliusEncryption sub-message and the
   * AES-GCM-wrapped body.
   */
  envelope: Uint8Array;
  /**
   * Cleartext content if the conversation is non-E2E (AI bot replies,
   * MEMORIES, etc.) — otherwise `undefined`. Surfaced when present so
   * consumers can render a message without going through decrypt.
   */
  cleartextBody?: string;
}
