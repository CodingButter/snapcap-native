/**
 * Messaging-domain bundle accessors — the `messaging` Zustand slice and
 * the chat-bundle module that exports the bundle-private send entries
 * (text / image / snap / mark-viewed / lifecycle / fetch).
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { ChatState, MessagingSlice, SendsModule } from "../types.ts";
import { chatStore } from "./chat.ts";
import { MOD_SENDS } from "./module-ids.ts";
import { reachModule } from "./reach.ts";

/**
 * Messaging slice — Zustand store on chat module 94704 (factory in chat
 * main byte ~6604846, beginning `messaging:{client:void 0,initializeClient:…`).
 *
 * Critical for presence bring-up. The presence slice's
 * `createPresenceSession(envelope)` action awaits
 * `firstValueFrom(observeConversationParticipants$)` inside
 * `PresenceServiceImpl`; that observable only emits when the target conv
 * is present in `state.messaging.conversations[convIdStr]`. Without
 * React running the bundle's normal feed-pump, the slice is empty, the
 * observable never emits, and `createPresenceSession` hangs forever —
 * see the long writeup on {@link MessagingSlice}.
 *
 * The fix is to call `messagingSlice(sandbox).fetchConversation(envelope)`
 * BEFORE `createPresenceSession`. The action drives
 * `S.ik(session, convRef)` (`convMgr.fetchConversation`) and writes
 * the result into the slice via `(0,fr.wD)(r, conversations)`, which
 * populates the `participants` payload the presence selector waits on.
 *
 * @internal Bundle-layer accessor. Public consumers reach this via
 * `Messaging.setTyping` / `Messaging.setViewing` (see `src/api/messaging.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `messaging` slice from the chat-bundle state
 */
export const messagingSlice = (sandbox: Sandbox): MessagingSlice =>
  (chatStore(sandbox).getState() as ChatState).messaging;

/**
 * Messaging sends + reads + lifecycle — chat module 56639.
 *
 * Exposes the bundle-private letter pairs (pn, E$, HM, Sd, Mw, ON, etc.)
 * that hang off `getConversationManager()` / `getFeedManager()` /
 * `getSnapManager()` on the WASM session. See {@link SendsModule} for
 * the full export map.
 *
 * @internal Bundle-layer accessor. Public consumers reach sends via
 * `Conversation.sendText` / `sendImage` / etc. (see `src/api/messaging.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-56639 export
 */
export const messagingSends = (sandbox: Sandbox): SendsModule =>
  reachModule<SendsModule>(sandbox, MOD_SENDS, "messagingSends");
