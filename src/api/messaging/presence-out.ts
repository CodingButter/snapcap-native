/**
 * Outbound presence — `setViewing` / `setRead`.
 *
 * `setTyping` lives in `./set-typing.ts` because of LOC budget; the
 * public re-export is in `./index.ts` so consumers see one uniform
 * surface.
 *
 * Each public function takes the per-instance `MessagingInternal` so
 * sibling state (the chat realm, presence cache, Map of per-conv
 * presence sessions) stays per-instance.
 *
 * ## Dual-path priming
 *
 * Modern Snap clients gate the indicators on the presence layer
 * (`state.presence.presenceSession.onUserAction({type: "chatVisible"})`)
 * rather than on the legacy convMgr pulses alone. Without priming,
 * the WASM logs `propagateTypingStateChange called while not in
 * chat_visible state` and recipients see nothing. Each method primes
 * the presence session AND fires the convMgr path, so cooperative
 * recipients on either side render the indicator. The bridge install
 * + per-conv `createPresenceSession` round-trip lives in
 * `./presence-bridge-init.ts`.
 *
 * @internal
 */
import type { MessagingInternal } from "./internal.ts";
import { buildConvRef, fireBundleCall } from "./conv-ref.ts";
import { ensurePresenceForConv } from "./presence-bridge-init.ts";

/**
 * Mark `convId` as actively viewed (chat-open / focused) for `durationMs`,
 * then auto-clear with an `exitConversation` pulse.
 *
 * Wires through module 56639 export `Mw` (enterConversation) →
 * `convMgr.enterConversation(convRef, source, cb)`. Snap propagates the
 * "active in chat" state to the peer's UI as the viewing indicator;
 * pairing it with `ON` (exitConversation) on teardown clears the state.
 * `try/finally` guarantees exit fires even on abort.
 *
 * @remarks Same dual-path treatment as `setTyping`:
 * primes `state.presence.presenceSession.onUserAction({type:
 * "chatVisible"})` so modern recipients honor the convMgr
 * `enterConversation` frame, and fires `chatHidden` on teardown so
 * the indicator clears immediately rather than waiting on the
 * recipient's idle timer.
 */
export async function setViewing(
  internal: MessagingInternal,
  convId: string,
  durationMs: number,
): Promise<void> {
  const _t0 = Date.now();
  process.stderr.write(`[trace.messaging] setViewing ENTER convId=${convId.slice(0, 8)} durationMs=${durationMs}\n`);
  await internal.ensureSession();
  const session = internal.session.get();
  const realm = internal.realm.get();
  if (!session || !realm) {
    process.stderr.write(`[trace.messaging] setViewing EXIT-EARLY no session/realm\n`);
    return;
  }
  const convRef = await buildConvRef(realm, convId);
  const sendsMod = realm.wreq("56639") as Record<string, Function>;
  const Mw = sendsMod.Mw as Function | undefined;
  const ON = sendsMod.ON as Function | undefined;
  if (typeof Mw !== "function") return;

  // Same gate-priming as setTyping — modern Snap recipients ignore
  // the convMgr enterConversation frame unless `chatVisible` has been
  // sent on the presence session first. Best-effort.
  const presenceSession = await ensurePresenceForConv(internal, convId);
  if (presenceSession) {
    try { presenceSession.onUserAction({ type: "chatVisible" }); }
    catch { /* tolerate */ }
  }

  try {
    // Source enum 0 = unspecified; bundle accepts and the WASM doesn't
    // care for presence-frame purposes. Real React caller passes the
    // ConversationEntrySource it tracks for analytics. Fire-and-forget
    // for the same reason as setTyping — the WS frame goes out before
    // the convMgr callback fires.
    fireBundleCall(() => Mw(session, convRef, 0));
    await new Promise<void>((r) => setTimeout(r, durationMs));
  } finally {
    // Auto-clear: explicit exitConversation cancels the viewing state
    // immediately. Runs on every code path (await complete, abort, throw)
    // so the peer's "viewing" UI never sticks. Fire-and-forget.
    if (typeof ON === "function") {
      fireBundleCall(() => ON(session, convRef, 0));
    }
    if (presenceSession) {
      try { presenceSession.onUserAction({ type: "chatHidden" }); }
      catch { /* tolerate */ }
    }
    process.stderr.write(`[trace.messaging] setViewing EXIT durMs=${Date.now() - _t0}\n`);
  }
}

/**
 * Mark `messageId` in `convId` as read (fires a read-receipt frame).
 * Resolves once the bundle has dispatched the notification.
 *
 * Wires through module 56639 export `cr` (displayedMessages wrapper) →
 * `convMgr.displayedMessages(convRef, messageIds, cb)`. The bundle's
 * WASM batches the IDs and pushes the read state over the duplex so the
 * sender's UI flips to "Opened" / removes the unread badge.
 *
 * @param convId - Hyphenated conversation UUID.
 * @param messageId - Server message id (bigint) or its decimal-string
 *   form. From a `RawEncryptedMessage`, this is the `messageId: bigint`
 *   field; from a live inbound `message` event, the underlying delegate
 *   record carries it as well.
 */
export async function setRead(
  internal: MessagingInternal,
  convId: string,
  messageId: string | bigint,
): Promise<void> {
  await internal.ensureSession();
  const session = internal.session.get();
  const realm = internal.realm.get();
  if (!session || !realm) return;
  const convRef = await buildConvRef(realm, convId);
  const sendsMod = realm.wreq("56639") as Record<string, Function>;
  const cr = sendsMod.cr as Function | undefined;
  if (typeof cr !== "function") return;
  // The Embind boundary expects a JS array of int64-coercible values
  // (BigInt). Coerce string → BigInt once so callers can pass either.
  const idBig = typeof messageId === "bigint" ? messageId : BigInt(messageId);
  // Fire-and-forget: the read-receipt WS frame leaves synchronously
  // when convMgr.displayedMessages dispatches. We don't gate caller
  // progress on the bundle's success-callback ack which doesn't always
  // fire (same pattern as sendText for bot convs).
  fireBundleCall(() => cr(session, convRef, [idBig]));
}
