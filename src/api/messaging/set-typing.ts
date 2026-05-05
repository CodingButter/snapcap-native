/**
 * `setTyping` — show typing indicator in `convId` for `durationMs`,
 * then auto-clear.
 *
 * Split out of `presence-out.ts` because the dual-path (convMgr pulse
 * loop + presence-slice broadcastTypingActivity) flow + the trace-log
 * instrumentation pushes the implementation past the per-file LOC cap.
 *
 * @internal
 */
import type { MessagingInternal } from "./internal.ts";
import { buildConvRef, fireBundleCall } from "./conv-ref.ts";
import { ensurePresenceForConv } from "./presence-bridge-init.ts";

/**
 * Show typing indicator in `convId` for `durationMs`, then auto-clear.
 *
 * Wires through the bundle's own typing helper — module 56639 export
 * `zM` (sendTypingNotification wrapper) → `convMgr.sendTypingNotification(convRef, kind, cb)`.
 * The bundle's TypingStateMachine on the **recipient** side starts a
 * ~3s idle timer on every received pulse and drops the indicator if
 * no follow-up arrives. To hold the indicator across windows longer
 * than 3s we re-pulse every 2.5s. **Auto-clear** is implicit:
 * returning from this function (or aborting / rejecting) stops the
 * pulse loop, and the recipient's idle timer takes the state to
 * "none" within ~3s — no peer ever sees a stale typing dot.
 *
 * @remarks
 * Drives **both** the legacy convMgr path (`sendTypingNotification`
 * via module 56639 export `zM`) AND the modern presence path
 * (`state.presence.initializePresenceServiceTs` + per-conv
 * `createPresenceSession` + `presenceSession.onUserAction({type:
 * "chatVisible"})` priming, then `broadcastTypingActivity`). Modern
 * Snap clients gate the typing indicator on the presence
 * `chat_visible` state — without priming, the WASM logs
 * `propagateTypingStateChange called while not in chat_visible state`
 * and recipients see nothing. Presence priming is best-effort: if
 * init fails (e.g. auth slice not ready), we fall through to the
 * convMgr-only path which still works for older peers.
 *
 * ```ts
 * await messaging.setTyping(convId, 1500);
 * await messaging.sendText(convId, "hello");
 * ```
 */
export async function setTyping(
  internal: MessagingInternal,
  convId: string,
  durationMs: number,
): Promise<void> {
  // [TRACE-INSTRUMENTATION-START] — remove with grep `\[trace\.`
  const _t0 = Date.now();
  process.stderr.write(`[trace.messaging] setTyping ENTER convId=${convId.slice(0, 8)} durationMs=${durationMs}\n`);
  // [TRACE-INSTRUMENTATION-END]
  await internal.ensureSession();
  const session = internal.session.get();
  const realm = internal.realm.get();
  if (!session || !realm) {
    process.stderr.write(`[trace.messaging] setTyping EXIT-EARLY no session/realm\n`);
    return; // best-effort if bring-up failed
  }
  const convRef = await buildConvRef(realm, convId);
  const sendsMod = realm.wreq("56639") as Record<string, Function>;
  const zM = sendsMod.zM as Function | undefined;
  if (typeof zM !== "function") {
    process.stderr.write(`[trace.messaging] setTyping EXIT-EARLY zM not a function\n`);
    return; // bundle shape shifted; resolve quietly
  }

  // Prime the bundle's presence layer in addition to the convMgr path.
  // Modern Snap mobile clients ignore the convMgr typing pulse unless
  // a `ChatPresenceSession.onUserAction({type: "chatVisible"})` has
  // fired first to put the local state into `chat_visible`. Without
  // this, the WASM logs `propagateTypingStateChange called while not
  // in chat_visible state` and suppresses the propagation.
  //
  // Best-effort: if the presence init / session creation fails (auth
  // slice not ready, presence slice shape shifted, etc.), fall through
  // to the convMgr-only path which still works for older web peers
  // and cooperative recipients.
  const presenceSession = await ensurePresenceForConv(internal, convId);
  process.stderr.write(`[trace.messaging] setTyping ensurePresenceForConv result=${presenceSession ? "session-obj" : "undefined"}\n`);
  if (presenceSession) {
    // Inspect the bundle's awayState gate + presenceSession identity at
    // broadcast time — confirms `chatVisible` priming actually flips the
    // slice's `awayState` to Present.
    try {
      const ctx = await internal.ctx();
      const { presenceSlice } = await import("../../bundle/register/index.ts");
      const slice = presenceSlice(ctx.sandbox) as Record<string, unknown>;
      process.stderr.write(`[trace.messaging] setTyping pre-chatVisible awayState=${String(slice.awayState)} slot-equals-cached=${slice.presenceSession === presenceSession}\n`);
    } catch (e) {
      process.stderr.write(`[trace.messaging] setTyping pre-chatVisible probe-threw=${(e as Error).message?.slice(0, 120)}\n`);
    }
    process.stderr.write(`[trace.messaging] setTyping → onUserAction(chatVisible+typing-active)\n`);
    try {
      presenceSession.onUserAction({
        type: "chatVisible",
        typingState: { state: "active" },
      });
      process.stderr.write(`[trace.messaging] setTyping ← onUserAction(chatVisible) ok\n`);
    } catch (e) {
      process.stderr.write(`[trace.messaging] setTyping ← onUserAction(chatVisible) THREW=${(e as Error).message?.slice(0, 200)}\n`);
    }
    try {
      const ctx = await internal.ctx();
      const { presenceSlice } = await import("../../bundle/register/index.ts");
      const slice = presenceSlice(ctx.sandbox) as Record<string, unknown>;
      process.stderr.write(`[trace.messaging] setTyping post-chatVisible awayState=${String(slice.awayState)}\n`);
    } catch { /* tolerate */ }
  }

  try {
    // Drive the convMgr typing pulse loop (existing path — leaves a
    // sendTypingNotification frame on the wire every ~2.5s). Combined
    // with the presence priming above, this satisfies BOTH the legacy
    // and modern recipient code paths.
    process.stderr.write(`[trace.messaging] setTyping → zM(session, convRef) (convMgr.sendTypingNotification)\n`);
    fireBundleCall(() => zM(session, convRef));

    // Also broadcast via the presence slice's own `broadcastTypingActivity`
    // action when a session is live — the slice gates this on the same
    // `awayState === Present` check our `document.hasFocus = () => true`
    // chat-loader patch satisfies. The slice action signature mirrors
    // {@link PresenceSlice.broadcastTypingActivity}: takes the envelope
    // already stored on `presenceSession.conversationId`. Best-effort.
    if (presenceSession) {
      try {
        const ctx = await internal.ctx();
        const { presenceSlice } = await import("../../bundle/register/index.ts");
        const envelope = presenceSession.conversationId as { id?: unknown; str?: string } | string | undefined;
        const envShape = envelope && typeof envelope === "object"
          ? `{id-bytelen=${(envelope.id as Uint8Array | undefined)?.byteLength}, str=${envelope.str?.slice(0, 8)}}`
          : `bare-string=${String(envelope).slice(0, 8)}`;
        process.stderr.write(`[trace.messaging] setTyping → broadcastTypingActivity envelope=${envShape}\n`);
        const r = presenceSlice(ctx.sandbox).broadcastTypingActivity(
          presenceSession.conversationId,
          "typing",
        );
        process.stderr.write(`[trace.messaging] setTyping ← broadcastTypingActivity returned=${typeof r} (${String(r).slice(0, 80)})\n`);
      } catch (e) {
        process.stderr.write(`[trace.messaging] setTyping ← broadcastTypingActivity THREW=${(e as Error).message?.slice(0, 200)}\n`);
      }
    }

    // Recipient's typing-state machine drops the indicator if no
    // valid typing frame arrives within ~3s. Pulse at 2s to give
    // ~1s of head-room. Each pulse re-fires `broadcastTypingActivity`
    // (the SAME proven action used at the initial fire above), NOT
    // the malformed `onUserAction({type:"chatVisible", typingState})`
    // shape that the bundle silently drops.
    const interval = 2000;
    const start = Date.now();
    const ctx = await internal.ctx();
    const { presenceSlice } = await import("../../bundle/register/index.ts");
    while (Date.now() - start < durationMs) {
      const remaining = durationMs - (Date.now() - start);
      await new Promise<void>((r) => setTimeout(r, Math.min(interval, remaining)));
      if (Date.now() - start < durationMs) {
        fireBundleCall(() => zM(session, convRef));
        if (presenceSession) {
          try {
            presenceSlice(ctx.sandbox).broadcastTypingActivity(
              presenceSession.conversationId,
              "typing",
            );
          } catch { /* tolerate */ }
        }
      }
    }
  } finally {
    // Auto-clear: stopping the convMgr pulse loop above lets the
    // recipient's TypingStateMachine drop within ~3s. Additionally
    // fire `chatHidden` on the presence session so modern clients
    // clear the dot immediately rather than waiting for the timer.
    if (presenceSession) {
      process.stderr.write(`[trace.messaging] setTyping FINALLY → onUserAction(chatHidden)\n`);
      try {
        presenceSession.onUserAction({ type: "chatHidden" });
        process.stderr.write(`[trace.messaging] setTyping FINALLY ← onUserAction(chatHidden) ok\n`);
      } catch (e) {
        process.stderr.write(`[trace.messaging] setTyping FINALLY ← onUserAction(chatHidden) THREW=${(e as Error).message?.slice(0, 200)}\n`);
      }
    }
    process.stderr.write(`[trace.messaging] setTyping EXIT durMs=${Date.now() - _t0}\n`);
  }
}
