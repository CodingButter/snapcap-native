/**
 * Raw envelope reads — direct gRPC-Web calls to
 * `MessagingCoreService` for inbox enumeration + historical message
 * backfill that doesn't need decrypt.
 *
 *   - `listConversations` — `SyncConversations`, returns the user's
 *     conversation list.
 *   - `fetchEncryptedMessages` — `BatchDeltaSync`, returns recent
 *     encrypted message envelopes per conv.
 *
 * Auth is bearer + parent-domain cookies — same pattern as
 * `api/fidelius.ts`. Stateless: every export takes the per-instance
 * `ClientContext` as the first arg.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import { ProtoWriter } from "../../transport/proto-encode.ts";
import { uuidToBytes } from "../_helpers.ts";
import { getOrCreateJar } from "../../shims/cookie-jar.ts";
import { nativeFetch } from "../../transport/native-fetch.ts";
import type { ConversationSummary, RawEncryptedMessage } from "./types.ts";
import { parseSyncConversations, parseBatchDeltaSync } from "./parse/index.ts";

/**
 * Fetch the user's full conversation list via `SyncConversations`.
 * Returns one entry per conversation — the same set the SPA shows on
 * its left panel.
 *
 * @param ctx - Per-instance client context.
 * @param selfUserId - Optional override for the calling user's UUID.
 *   When omitted, resolved from the chat-bundle's auth slice.
 *
 * @internal
 */
export async function listConversations(
  ctx: ClientContext,
  selfUserId?: string,
): Promise<ConversationSummary[]> {
  selfUserId = selfUserId ?? await getSelfUserId(ctx);
  const w = new ProtoWriter();
  w.fieldMessage(1, (m) => m.fieldBytes(1, uuidToBytes(selfUserId)));
  w.fieldString(2, "useV4");
  w.fieldBytes(4, new Uint8Array(0));
  w.fieldVarint(5, 1);
  const respBytes = await grpcCall(ctx, "SyncConversations", w.finish());
  return parseSyncConversations(respBytes);
}

/**
 * Fetch raw encrypted message envelopes for the given conversations
 * via `BatchDeltaSync`.
 *
 * @internal
 */
export async function fetchEncryptedMessages(
  ctx: ClientContext,
  conversations: ConversationSummary[],
  selfUserId?: string,
): Promise<RawEncryptedMessage[]> {
  selfUserId = selfUserId ?? await getSelfUserId(ctx);
  const w = new ProtoWriter();
  for (const c of conversations) {
    const otherUser = c.participants.find((p) => p !== selfUserId) ?? selfUserId;
    // Captured shape: { 2: {1: bytes16 convId}, 4: {1: bytes16 self},
    //                   6: {1: bytes16 other}, 7: varint=1 }
    w.fieldMessage(1, (m) => {
      m.fieldMessage(2, (mm) => mm.fieldBytes(1, uuidToBytes(c.conversationId)));
      m.fieldMessage(4, (mm) => mm.fieldBytes(1, uuidToBytes(selfUserId)));
      m.fieldMessage(6, (mm) => mm.fieldBytes(1, uuidToBytes(otherUser)));
      m.fieldVarint(7, 1);
    });
  }
  const respBytes = await grpcCall(ctx, "BatchDeltaSync", w.finish());
  return parseBatchDeltaSync(respBytes);
}

/**
 * Resolve the calling user's UUID from the chat-bundle's auth slice.
 * Throws when the slice has not yet populated `userId` — the messaging
 * bring-up is what ultimately lands it.
 *
 * @internal
 */
export async function getSelfUserId(ctx: ClientContext): Promise<string> {
  // Try the chat-bundle's auth slice first — has `userId` once the
  // session is brought up.
  try {
    const { authSlice } = await import("../../bundle/register/index.ts");
    const slice = authSlice(ctx.sandbox) as { userId?: string };
    if (typeof slice.userId === "string" && slice.userId.length >= 32) {
      return slice.userId;
    }
  } catch { /* slice not available — fall through */ }
  throw new Error("Messaging.getSelfUserId: chat-bundle auth slice has no userId yet; pass selfUserId explicitly to listConversations / fetchEncryptedMessages");
}

/**
 * Issue a `MessagingCoreService.<methodName>` gRPC-Web POST with
 * `body` as the request payload. Returns the data-frame payload from
 * the response (or empty `Uint8Array` for write-only methods that only
 * return an OK trailer).
 *
 * @internal
 */
export async function grpcCall(ctx: ClientContext, methodName: string, body: Uint8Array): Promise<Uint8Array> {
  const auth = await import("../auth/index.ts");
  const bearer = auth.getAuthToken(ctx);
  const sharedJar = getOrCreateJar(ctx.dataStore);
  const cookieHeader = (await sharedJar.getCookies("https://web.snapchat.com"))
    .map((c) => `${c.key}=${c.value}`)
    .join("; ");
  const framed = new Uint8Array(5 + body.byteLength);
  new DataView(framed.buffer).setUint32(1, body.byteLength, false);
  framed.set(body, 5);
  const url = `https://web.snapchat.com/messagingcoreservice.MessagingCoreService/${methodName}`;
  // mcs-cof-ids-bin: Snap's web client sends a bin-encoded protobuf
  // metadata listing the COF (Circle of Friends) feature ids the
  // client supports. CreateContentMessage in particular looks at this
  // header to gate delivery; without it Snap returns an OK trailer
  // but silently drops the message. The captured value below is the
  // exact bytes from recon-bin/text-dm-create-content-message.req.headers.json
  // and is stable across the chat-bundle build we vendor.
  const headers: Record<string, string> = {
    "authorization": `Bearer ${bearer}`,
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    "x-user-agent": "grpc-web-javascript/0.1",
    "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
    "user-agent": ctx.userAgent,
    "accept": "*/*",
    "cookie": cookieHeader,
  };
  if (methodName === "CreateContentMessage") {
    headers["mcs-cof-ids-bin"] = "ChjSlcACiLO9AcSl8gLelrIBipe7AYzw4QE=";
  }
  const r = await nativeFetch(url, {
    method: "POST",
    headers,
    body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
  });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (r.status !== 200) {
    const grpcStatus = r.headers.get("grpc-status");
    const grpcMessage = r.headers.get("grpc-message");
    throw new Error(`Messaging.grpcCall(${methodName}) status=${r.status} grpc-status=${grpcStatus} grpc-message=${grpcMessage}`);
  }
  // gRPC-Web framing: each frame = 1-byte flag + 4-byte big-endian length
  // + payload. Flag bit 0x80 indicates a trailer-only frame (text key:val
  // pairs separated by \r\n). Walk every frame; the data frame is the
  // payload, trailer frames carry grpc-status / grpc-message.
  let pos = 0;
  let dataPayload: Uint8Array | undefined;
  let trailerStatus = 0;
  let trailerMessage = "";
  while (pos + 5 <= buf.byteLength) {
    const flag = buf[pos]!;
    const fLen = new DataView(buf.buffer, buf.byteOffset + pos + 1, 4).getUint32(0, false);
    const start = pos + 5;
    const end = start + fLen;
    if (end > buf.byteLength) break;
    const slice = buf.subarray(start, end);
    if ((flag & 0x80) === 0) {
      dataPayload = slice;
    } else {
      const trailerStr = new TextDecoder().decode(slice);
      const m = trailerStr.match(/grpc-status:\s*(\d+)/i);
      if (m) trailerStatus = parseInt(m[1]!);
      const mm = trailerStr.match(/grpc-message:\s*(.+)/i);
      if (mm) trailerMessage = mm[1]!.trim();
    }
    pos = end;
  }
  if (trailerStatus !== 0) {
    throw new Error(`Messaging.grpcCall(${methodName}) grpc-status=${trailerStatus} grpc-message=${trailerMessage}`);
  }
  if (!dataPayload) {
    // Some methods (write-only) legitimately return no data frame, only
    // an OK trailer. Return empty.
    return new Uint8Array(0);
  }
  return dataPayload;
}
