/**
 * Inbound wire-format parsers for `MessagingCoreService`.
 *
 * Stateless functions. Each takes raw response bytes and returns the
 * surfaced typed shape (`ConversationSummary[]` / `RawEncryptedMessage[]`
 * / extracted UUIDs / extracted plaintext).
 *
 * @internal
 */
export { ProtoReader } from "./proto-reader.ts";
export {
  parseSyncConversations,
  parseOneSyncedConversation,
} from "./sync-conversations.ts";
export {
  parseBatchDeltaSync,
  parseSyncedConversation,
  parseContentMessage,
} from "./batch-delta.ts";
export { extractFirstUuidFromResp, extractPlaintextBody } from "./envelope.ts";
