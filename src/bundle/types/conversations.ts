/**
 * Bundle-realm conversation result shape — what the messaging session's
 * `fetchConversationWithMessages` / paginated sibling resolve to. The
 * `messages` and `conversation` slots stay `unknown` because the SDK
 * doesn't decode them; only `hasMoreMessages` is consumed for pagination
 * stop-conditions.
 */

/**
 * Result shape of `fetchConversationWithMessages` /
 * `fetchConversationWithMessagesPaginated`. Mirrors the bundle wrapper's
 * resolve shape (chat main byte ~4931600).
 *
 * @internal Bundle wire-format type.
 */
export type FetchConversationWithMessagesResult = {
  /** Bundle-realm `Map<MessageId, MessageRecord>` of messages in the conversation. */
  messages: unknown;
  /** Bundle-realm `Conversation` record (metadata, last activity, participants). */
  conversation: unknown;
  /** True when older pages are available — call the paginated sibling to walk them. */
  hasMoreMessages: boolean;
};
