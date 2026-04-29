/**
 * Presence channel publishes — sent over the duplex WebSocket.
 *
 * Real-time presence (typing indicator, "viewing chat" indicator) requires
 * fanning out to recipients via the duplex WS, not the regular gRPC-Web
 * HTTP path. This module builds the per-channel payloads that ride inside
 * the WS's `send-transient-message` envelope.
 */
import { ProtoWriter } from "../transport/proto-encode.ts";

/**
 * Counter values observed in captured browser frames. The same `presence`
 * channel carries multiple states; the counter inside field 4.2.1 is what
 * differentiates them.
 */
export const PresenceCounter = {
  /** "I'm in this chat" — recipient sees a viewing indicator (bitmoji pose changes). */
  VIEWING: 1,
  /** "I'm typing right now" — recipient sees "<name> is typing…". */
  TYPING: 33,
} as const;

/**
 * Build the body for a "presence" channel publish.
 *
 * Wire shape (lifted from captured browser frames — the user was logged in
 * as user A, sending presence in conversations with user B and user C; both
 * frames carried user A in field 2, only the conversation ID and outer
 * wrapper changed):
 *
 *   { 2: string senderUserId,                    // ME — the logged-in user
 *     4 (repeated): { 1: string id,              // "<me>:<sessionId>" then just "<me>"
 *                     2: { 1: int counter } },
 *     5: int timestampMs,
 *     6: string conversationId,
 *     7: int sessionId,                          // per-WS-connection, shared across convs
 *     8: int = 2 (constant) }
 *
 * The peer is identified at the OUTER envelope level (the bytes16 wrapper
 * Duplex.sendTransient builds), not in this body.
 *
 * Bindings shape variants observed:
 *   - "subscribe" frame includes both `<me>:<session>` and `<me>` bindings (380b)
 *   - "heartbeat" frame omits the bindings entirely (240b body)
 * We always send the full subscribe form for now.
 */
export function buildPresenceBody(opts: {
  senderUserId: string;
  conversationId: string;
  sessionId: bigint;
  /** State counter — observed values: 1 (initial subscribe), 33 (subsequent activity). */
  counter: number;
  timestampMs?: number;
}): Uint8Array {
  const ts = opts.timestampMs ?? Date.now();
  const w = new ProtoWriter();
  w.fieldString(2, opts.senderUserId);
  w.fieldMessage(4, (sub) => {
    sub.fieldString(1, `${opts.senderUserId}:${opts.sessionId}`);
    sub.fieldMessage(2, (state) => state.fieldVarint(1, opts.counter));
  });
  w.fieldMessage(4, (sub) => {
    sub.fieldString(1, opts.senderUserId);
    sub.fieldMessage(2, (state) => state.fieldVarint(1, opts.counter));
  });
  w.fieldVarint(5, ts);
  w.fieldString(6, opts.conversationId);
  w.fieldVarint(7, opts.sessionId);
  w.fieldVarint(8, 2);
  return w.finish();
}
