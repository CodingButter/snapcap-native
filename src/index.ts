/**
 * @snapcap/native — browser-free Snap client.
 *
 * Loads Snap's web JavaScript bundle and WASM modules directly in Node,
 * with shimmed Chrome APIs so the bundle "thinks" it's still running in
 * Chromium. Runs many accounts on a fraction of the resources Playwright
 * would require.
 */
export { SnapcapClient, type SnapcapAuthBlob, type FromCredentialsOpts, type FromAuthOpts } from "./client.ts";
export { Conversation, TypingActivity, ConversationViewState, type ConversationKind } from "./api/messaging.ts";
export { User } from "./api/user.ts";
export { FriendAction } from "./api/friending.ts";
export { uuidToBytes, bytesToUuid, uuidToHighLow } from "./transport/proto-encode.ts";
