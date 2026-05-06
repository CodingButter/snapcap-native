/**
 * Direct gRPC-Web image-DM pipeline.
 *
 * Three-step send (lifted from a real captured HAR):
 *   1. POST `MediaDeliveryService/getUploadLocations` → signed S3 PUT URL
 *      + media-id token.
 *   2. AES-256-CBC encrypt the image bytes (fresh per-message random
 *      key + IV); HTTP PUT ciphertext to that URL.
 *   3. POST `MessagingCoreService/CreateContentMessage` with the media-id
 *      + encryption key + IV embedded.
 *
 * No Fidelius wrap at the envelope layer — the per-image AES key is
 * embedded in the message body, recipients fetch from S3 and decrypt
 * client-side. This is how the official web client sends image DMs.
 *
 * Originally proven end-to-end at commit `9d828d0`; this is a port of
 * that wire shape to the post-refactor `ClientContext` API surface.
 *
 * @internal
 */
import { randomBytes, createCipheriv } from "node:crypto";
import { ProtoWriter } from "../transport/proto-encode.ts";
import { uuidToBytes } from "./_helpers.ts";
import { nativeFetch } from "../transport/native-fetch.ts";
import { getOrCreateJar } from "../shims/cookie-jar.ts";
import type { ClientContext } from "./_context.ts";

// ── Image dimension parsing (PNG / JPEG / WebP) ───────────────────────

function parseImageDimensions(
  bytes: Uint8Array,
  override?: { width?: number; height?: number },
): { width: number; height: number } {
  if (override?.width && override?.height) return { width: override.width, height: override.height };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature + IHDR width/height as uint32 BE at 16-23.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // JPEG: scan for SOFn marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === undefined) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: dv.getUint16(i + 7, false), height: dv.getUint16(i + 5, false) };
      }
      const segLen = dv.getUint16(i + 2, false);
      i += 2 + segLen;
    }
  }
  // WebP: VP8 lossy — bytes 26-29 (uint16 LE, mask low 14 bits).
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
  }
  if (override?.width && override?.height) return { width: override.width, height: override.height };
  throw new Error("parseImageDimensions: unsupported image format and no width/height override given");
}

// ── 1. getUploadLocations ─────────────────────────────────────────────

type UploadLocation = {
  putUrl: string;
  mediaIdToken: string;  // e.g. "wO87suY3U6Ss473nIx9ba_1"
  mediaIdBase: string;   // e.g. "wO87suY3U6Ss473nIx9ba"
};

async function getUploadLocations(ctx: ClientContext): Promise<UploadLocation> {
  const body = (() => {
    const w = new ProtoWriter();
    w.fieldVarint(2, 1);
    w.fieldVarint(4, 1);
    w.fieldBytes(7, new Uint8Array([0]));
    w.fieldVarint(16, 1);
    return w.finish();
  })();
  const respBytes = await grpcWebPost(
    ctx,
    "snapchat.content.v2.MediaDeliveryService",
    "getUploadLocations",
    body,
  );
  return parseUploadLocationsResponse(respBytes);
}

function parseUploadLocationsResponse(buf: Uint8Array): UploadLocation {
  const top = walkProto(buf).field(1)?.message;
  if (!top) throw new Error("getUploadLocations response: missing field 1");
  const putUrl = top.field(1)?.string ?? "";
  const tokenMsg = top.field(4)?.message?.field(3)?.message;
  const mediaIdToken = tokenMsg?.field(1)?.string ?? "";
  const mediaIdBase = tokenMsg?.field(2)?.message?.field(2)?.string ?? "";
  if (!putUrl || !mediaIdToken || !mediaIdBase) {
    throw new Error(`getUploadLocations: incomplete response (url=${!!putUrl}, token=${!!mediaIdToken}, base=${!!mediaIdBase})`);
  }
  return { putUrl, mediaIdToken, mediaIdBase };
}

// ── 2. AES-256-CBC encrypt + S3 PUT ───────────────────────────────────

function encryptMedia(plaintext: Uint8Array): { ciphertext: Uint8Array; key: Uint8Array; iv: Uint8Array } {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: new Uint8Array(ciphertext), key: new Uint8Array(key), iv: new Uint8Array(iv) };
}

async function uploadEncrypted(putUrl: string, ciphertext: Uint8Array): Promise<void> {
  // The pre-signed URL already carries `x-amz-acl` in its query string;
  // sending it as a header would change the canonical request and break
  // the AWS4 signature → 404.
  const body = ciphertext.buffer.slice(
    ciphertext.byteOffset,
    ciphertext.byteOffset + ciphertext.byteLength,
  ) as ArrayBuffer;
  const resp = await nativeFetch(putUrl, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      origin: "https://www.snapchat.com",
      referer: "https://www.snapchat.com/",
    },
    body,
  });
  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new Error(`media upload failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
}

// ── 3. CreateContentMessage (image variant) ───────────────────────────

type SendImageReq = {
  senderUserId: string;
  conversationId: string;
  width: number;
  height: number;
  mediaIdToken: string;
  mediaIdBase: string;
  encryptionKey: Uint8Array;
  encryptionIv: Uint8Array;
  messageId?: bigint;
  clientMessageId?: string;
};

function encodeCreateContentMessageMedia(req: SendImageReq): Uint8Array {
  const w = new ProtoWriter();
  w.fieldMessage(1, (s) => s.fieldBytes(1, uuidToBytes(req.senderUserId)));
  w.fieldVarint(2, req.messageId ?? randomInt64Positive());
  w.fieldMessage(3, (dest) => {
    dest.fieldMessage(1, (inner) => {
      inner.fieldMessage(1, (cid) => cid.fieldBytes(1, uuidToBytes(req.conversationId)));
      inner.fieldVarint(2, 111); // DM-with-media destination kind
    });
  });
  w.fieldMessage(4, (content) => {
    content.fieldVarint(2, 2); // content kind = MEDIA
    content.fieldMessage(4, (m1) => {
      m1.fieldMessage(3, (m2) => {
        m2.fieldMessage(3, (mediaWrapper) => {
          mediaWrapper.fieldVarint(8, 2);
          mediaWrapper.fieldMessage(4, (meta) => {
            meta.fieldVarint(6, 1);
            meta.fieldString(10, "1");
            meta.fieldVarint(8, 2);
          });
          mediaWrapper.fieldMessage(5, (descWrap) => {
            descWrap.fieldMessage(1, (d1) => {
              d1.fieldMessage(1, (d2) => {
                d2.fieldMessage(5, (dim) => {
                  dim.fieldVarint(1, req.width);
                  dim.fieldVarint(2, req.height);
                });
                d2.fieldBytes(18, new Uint8Array(0));
                // Encryption key + IV — Snap stores them TWICE: field 4
                // as base64 strings, field 19 as raw bytes. Different
                // recipient clients read different fields; both must
                // carry the SAME values.
                d2.fieldMessage(4, (keys) => {
                  keys.fieldString(1, btoa(String.fromCharCode(...req.encryptionKey)));
                  keys.fieldString(2, btoa(String.fromCharCode(...req.encryptionIv)));
                });
                d2.fieldMessage(19, (alt) => {
                  alt.fieldBytes(1, req.encryptionKey);
                  alt.fieldBytes(2, req.encryptionIv);
                });
                d2.fieldVarint(20, 3);
                d2.fieldVarint(22, 1);
              });
            });
            descWrap.fieldMessage(2, (footer) => {
              footer.fieldBytes(7, new Uint8Array(0));
              footer.fieldBytes(9, new Uint8Array(0));
            });
          });
          mediaWrapper.fieldBytes(13, new Uint8Array(0));
          mediaWrapper.fieldMessage(17, (ts) => ts.fieldVarint(4, Date.now()));
          mediaWrapper.fieldMessage(22, (m22) => m22.fieldVarint(1, 7));
        });
      });
    });
    content.fieldMessage(5, (ref) => {
      ref.fieldMessage(1, (r1) => {
        r1.fieldMessage(3, (r3) => {
          r3.fieldString(1, req.mediaIdToken);
          r3.fieldMessage(2, (r3b) => {
            r3b.fieldString(2, req.mediaIdBase);
            r3b.fieldBytes(6, new Uint8Array([4]));
            r3b.fieldVarint(9, 1);
            r3b.fieldVarint(10, 11);
            r3b.fieldVarint(12, 1);
          });
        });
        r1.fieldVarint(8, 2);
      });
    });
    content.fieldBytes(6, new Uint8Array(0));
    content.fieldVarint(7, 2);
  });
  w.fieldMessage(8, (cm) => {
    cm.fieldMessage(1, (id) =>
      id.fieldBytes(1, uuidToBytes(req.clientMessageId ?? crypto.randomUUID())),
    );
  });
  return w.finish();
}

function randomInt64Positive(): bigint {
  return (BigInt(Date.now()) << 16n) | BigInt(Math.floor(Math.random() * 0xffff));
}

// ── 4. Top-level send-image orchestrator ──────────────────────────────

export async function sendImageDirect(
  ctx: ClientContext,
  conversationId: string,
  bytes: Uint8Array,
  opts: { width?: number; height?: number } = {},
): Promise<void> {
  const senderUserId = await getSelfUserId(ctx);
  const { width, height } = parseImageDimensions(bytes, opts);
  const loc = await getUploadLocations(ctx);
  const enc = encryptMedia(bytes);
  await uploadEncrypted(loc.putUrl, enc.ciphertext);
  const ccmBody = encodeCreateContentMessageMedia({
    senderUserId,
    conversationId,
    width,
    height,
    mediaIdToken: loc.mediaIdToken,
    mediaIdBase: loc.mediaIdBase,
    encryptionKey: enc.key,
    encryptionIv: enc.iv,
  });
  await grpcWebPost(
    ctx,
    "messagingcoreservice.MessagingCoreService",
    "CreateContentMessage",
    ccmBody,
  );
}

// ── gRPC-Web POST helper (cookies + bearer threaded) ──────────────────

async function grpcWebPost(
  ctx: ClientContext,
  service: string,
  methodName: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  const { getAuthToken } = await import("./auth/index.ts");
  const bearer = getAuthToken(ctx);
  if (!bearer) throw new Error(`grpcWebPost(${methodName}): no bearer`);
  const sharedJar = getOrCreateJar(ctx.dataStore);
  const cookieHeader = (await sharedJar.getCookies("https://web.snapchat.com"))
    .map((c) => `${c.key}=${c.value}`)
    .join("; ");
  const framed = new Uint8Array(5 + body.byteLength);
  new DataView(framed.buffer).setUint32(1, body.byteLength, false);
  framed.set(body, 5);
  const url = `https://web.snapchat.com/${service}/${methodName}`;
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
  const respBuf = new Uint8Array(await r.arrayBuffer());
  if (r.status !== 200) {
    const grpcStatus = r.headers.get("grpc-status");
    const grpcMessage = r.headers.get("grpc-message");
    throw new Error(`grpcWebPost(${methodName}) status=${r.status} grpc-status=${grpcStatus} grpc-message=${grpcMessage}`);
  }
  // Walk frames: data frame (flag bit 0 clear), trailer frame (flag bit 0x80).
  let pos = 0;
  let dataPayload: Uint8Array | undefined;
  while (pos + 5 <= respBuf.byteLength) {
    const flag = respBuf[pos]!;
    const fLen = new DataView(respBuf.buffer, respBuf.byteOffset + pos + 1, 4).getUint32(0, false);
    const start = pos + 5;
    const end = start + fLen;
    if (flag === 0) dataPayload = respBuf.slice(start, end);
    pos = end;
  }
  return dataPayload ?? new Uint8Array(0);
}

async function getSelfUserId(ctx: ClientContext): Promise<string> {
  const { getSelfUserId: g } = await import("./messaging/reads.ts");
  return g(ctx);
}

// ── Tiny tolerant proto walker (read-only) ────────────────────────────

type ProtoNode = { field(n: number): ProtoFieldVal | undefined };
type ProtoFieldVal = { varint?: bigint; string?: string; bytes?: Uint8Array; message?: ProtoNode };

function walkProto(buf: Uint8Array): ProtoNode {
  const fields = new Map<number, ProtoFieldVal>();
  let pos = 0;
  while (pos < buf.byteLength) {
    const [tag, p1] = readVarint(buf, pos); pos = p1;
    const fnum = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 0) {
      const [v, p2] = readVarint(buf, pos); pos = p2;
      if (!fields.has(fnum)) fields.set(fnum, { varint: v });
    } else if (wt === 2) {
      const [len, p2] = readVarint(buf, pos); pos = p2;
      const sub = buf.slice(pos, pos + Number(len));
      pos += Number(len);
      const allPrint = sub.length > 0 && sub.every((b) => b >= 0x20 && b < 0x7f);
      const v: ProtoFieldVal = { bytes: sub };
      if (allPrint) v.string = new TextDecoder().decode(sub);
      // Try parsing as nested submessage too — non-throwing.
      try { v.message = walkProto(sub); } catch { /* not a message */ }
      if (!fields.has(fnum)) fields.set(fnum, v);
    } else if (wt === 1) { pos += 8; } else if (wt === 5) { pos += 4; } else break;
  }
  return { field: (n) => fields.get(n) };
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let v = 0n; let shift = 0n;
  while (pos < buf.byteLength) {
    const b = buf[pos]!;
    pos += 1;
    v |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v, pos];
    shift += 7n;
  }
  return [v, pos];
}
