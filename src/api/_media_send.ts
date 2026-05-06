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

/**
 * Parse intrinsic width / height from the leading bytes of a supported
 * image format. The CCM envelope carries dimensions explicitly so the
 * recipient client can size the placeholder before the CDN download
 * lands; mismatched dimensions render at the wrong aspect ratio.
 *
 * Supports PNG (signature + IHDR), JPEG (SOFn marker scan), and WebP
 * VP8 (lossy at fixed offsets). For VP8L / VP8X / GIF / SVG / unknown
 * formats, pass an explicit `override.width` + `override.height` from
 * the caller.
 *
 * @param bytes - Raw image bytes (the same bytes passed to `sendImage`).
 * @param override - Optional explicit `{width, height}`. If both are
 *   provided, parsing is skipped — useful for formats not auto-detected
 *   or when the caller already knows the dimensions.
 * @returns `{width, height}` in pixels.
 * @throws If the format isn't recognized AND no override was provided.
 *
 * @internal
 */
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

/**
 * Result of {@link getUploadLocations}. The two ids are referenced from
 * the `CreateContentMessage` envelope: `mediaIdToken` from the media
 * descriptor (with `_<index>` suffix), `mediaIdBase` from the inner
 * reference object (without suffix).
 *
 * @internal
 */
type UploadLocation = {
  /** Pre-signed S3 PUT URL — valid ~24h. AWS4-HMAC-SHA256 signed; do
   *  NOT add `x-amz-acl` as a header (already in the query string). */
  putUrl: string;
  /** Token with `_<index>` suffix referenced from the message descriptor.
   *  Example: `"wO87suY3U6Ss473nIx9ba_1"`. */
  mediaIdToken: string;
  /** Base media-id (no suffix). Example: `"wO87suY3U6Ss473nIx9ba"`. */
  mediaIdBase: string;
};

/**
 * Step 1 of the image-send pipeline: ask Snap for a CDN upload URL.
 *
 * Sends a tiny gRPC-Web POST to
 * `snapchat.content.v2.MediaDeliveryService/getUploadLocations`. The
 * 10-byte request body was lifted verbatim from a captured HAR — fields
 * 2/4/16 = 1 declare the image variant; field 7 byte differs between
 * media kinds and we hard-code the image one.
 *
 * @param ctx - Per-instance {@link ClientContext} (bearer + cookies).
 * @returns Resolved {@link UploadLocation}.
 * @throws If the gRPC call returns non-200 or the response is missing
 *   any of `uploadUrl` / `mediaIdToken` / `mediaIdBase`.
 *
 * @internal
 */
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

/**
 * Step 2a of the pipeline: encrypt the image bytes with a fresh random
 * AES-256-CBC key and IV. Snap's regular media flow stores blobs encrypted
 * at rest in S3; the per-image key + IV travel inside the message body
 * (see {@link encodeCreateContentMessageMedia}), so any recipient client
 * with the message can fetch and decrypt.
 *
 * Distinct from Fidelius — this is the regular media-at-rest layer, not
 * the E2E identity layer. Image DMs use only this; snaps add Fidelius on
 * top.
 *
 * @param plaintext - Raw image bytes.
 * @returns `{ciphertext, key (32 bytes), iv (16 bytes)}`.
 *
 * @internal
 */
function encryptMedia(plaintext: Uint8Array): { ciphertext: Uint8Array; key: Uint8Array; iv: Uint8Array } {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: new Uint8Array(ciphertext), key: new Uint8Array(key), iv: new Uint8Array(iv) };
}

/**
 * Step 2b of the pipeline: HTTP PUT the ciphertext to the pre-signed
 * S3 URL returned by {@link getUploadLocations}.
 *
 * Header set kept minimal to match what Chrome actually sends. Critically,
 * the pre-signed URL already carries `x-amz-acl=public-read` in its query
 * string; sending it as a header would change the canonical request and
 * break the AWS4 signature → 404.
 *
 * @param putUrl - Pre-signed S3 URL from `UploadLocation.putUrl`.
 * @param ciphertext - AES-encrypted image bytes (output of {@link encryptMedia}).
 * @throws If S3 returns non-200 (the message includes the response body
 *   prefix to aid debugging).
 *
 * @internal
 */
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

/**
 * Inputs to {@link encodeCreateContentMessageMedia} — the message-side
 * fields that ride alongside the uploaded media. Most fields are ids;
 * `messageId` and `clientMessageId` default to fresh values when omitted.
 *
 * @internal
 */
type SendImageReq = {
  /** Sender's hyphenated UUID. */
  senderUserId: string;
  /** Recipient conversation's hyphenated UUID. */
  conversationId: string;
  /** Image width in pixels (from {@link parseImageDimensions}). */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Media-id with `_<index>` suffix (`UploadLocation.mediaIdToken`). */
  mediaIdToken: string;
  /** Media-id without suffix (`UploadLocation.mediaIdBase`). */
  mediaIdBase: string;
  /** AES-256 key used to encrypt the uploaded blob (32 bytes). */
  encryptionKey: Uint8Array;
  /** AES-CBC IV used alongside the key (16 bytes). */
  encryptionIv: Uint8Array;
  /** Server-side int64 message id. Defaults to a timestamp+random hybrid. */
  messageId?: bigint;
  /** Idempotency UUID — defaults to a fresh `crypto.randomUUID()`. */
  clientMessageId?: string;
};

/**
 * Hand-written proto encoder for `MessagingCoreService.CreateContentMessage`
 * — image variant. Wire shape recovered from a captured HAR; field tags
 * and nesting verified against real recipient delivery.
 *
 * Two key gotchas baked in:
 *
 *   - The encryption key + IV are stored TWICE in the descriptor: field
 *     4 carries them as base64 strings, field 19 as raw bytes. Different
 *     recipient clients read different fields; both must carry the SAME
 *     values or recipients see "tap to view" with nothing displayed.
 *   - DM-with-media uses destination kind=111 (vs 8 for text-only DM).
 *
 * @param req - Already-resolved {@link SendImageReq} (post upload).
 * @returns Proto bytes ready for gRPC-Web framing.
 *
 * @internal
 */
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

/**
 * Generate a positive 63-bit message id from the current timestamp +
 * 16 bits of randomness. Snap doesn't validate the structure — what
 * matters is uniqueness within a sender's outbound stream — so the
 * timestamp prefix gives ordering for free.
 *
 * @internal
 */
function randomInt64Positive(): bigint {
  return (BigInt(Date.now()) << 16n) | BigInt(Math.floor(Math.random() * 0xffff));
}

// ── 4. Top-level send-image orchestrator ──────────────────────────────

/**
 * Send a persistent image DM into a conversation via the direct gRPC-Web
 * pipeline. Bypasses Snap's bundle session entirely — no canvas, no
 * Image shim, no Fidelius wrap on the envelope.
 *
 * # Flow
 *
 *   1. {@link getUploadLocations} — signed S3 PUT URL + media-id token.
 *   2. {@link encryptMedia} (AES-256-CBC) → {@link uploadEncrypted} (PUT).
 *   3. {@link encodeCreateContentMessageMedia} → gRPC-Web POST to
 *      `MessagingCoreService/CreateContentMessage`.
 *
 * Recipients fetch from S3 and decrypt client-side with the per-message
 * key embedded in the envelope. Verified live ~370 ms wall.
 *
 * Does NOT need the bundle messaging session to be brought up — works
 * cold from any authenticated `ClientContext`.
 *
 * @param ctx - Per-instance {@link ClientContext}.
 * @param conversationId - Recipient conversation's hyphenated UUID.
 * @param bytes - Raw image bytes (PNG / JPEG / WebP). Sent as-is; no
 *   resizing or re-encoding.
 * @param opts - Optional `{width, height}` override for image formats
 *   {@link parseImageDimensions} doesn't auto-detect.
 *
 * @internal Public surface is `Messaging.sendImage`.
 */
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

/**
 * Generic gRPC-Web POST with bearer + cookies attached. Handles request
 * framing (1-byte flag + 4-byte big-endian length + payload), walks the
 * frame chain on the response side to extract the data frame (skipping
 * trailer frames marked by flag bit 0x80).
 *
 * Mirrors `src/api/messaging/reads.ts:grpcCall` — pulled inline here to
 * keep `_media_send.ts` self-contained as a reference for the wire
 * shape. If we add another direct-gRPC caller, fold both onto a shared
 * helper.
 *
 * @param ctx - Per-instance {@link ClientContext}.
 * @param service - Fully-qualified service name (e.g.
 *   `"messagingcoreservice.MessagingCoreService"`).
 * @param methodName - Method on the service (e.g. `"CreateContentMessage"`).
 * @param body - Already-encoded request bytes.
 * @returns Decoded data-frame bytes from the response (empty if none).
 * @throws If the HTTP layer or gRPC trailer signals failure.
 *
 * @internal
 */
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

/**
 * Resolve the authenticated user's hyphenated UUID. Reads through the
 * shared messaging-domain helper so the source of truth (the bundle's
 * auth slice) stays consistent with how the rest of the SDK derives
 * `senderUserId`.
 *
 * @internal
 */
async function getSelfUserId(ctx: ClientContext): Promise<string> {
  const { getSelfUserId: g } = await import("./messaging/reads.ts");
  return g(ctx);
}

// ── Tiny tolerant proto walker (read-only) ────────────────────────────

/**
 * Read-only proto field accessor returned by {@link walkProto}.
 *
 * @internal
 */
type ProtoNode = { field(n: number): ProtoFieldVal | undefined };
/**
 * Decoded field value. Multiple shape projections are populated when
 * applicable (e.g. a length-delimited field that's also valid UTF-8 has
 * both `bytes` and `string` set; a nested message also has `message`).
 *
 * @internal
 */
type ProtoFieldVal = { varint?: bigint; string?: string; bytes?: Uint8Array; message?: ProtoNode };

/**
 * Tolerant proto walker — decodes whatever it can without a schema and
 * returns a `field(n)` accessor. Unknown / corrupt fields are skipped
 * silently. Used to extract `uploadUrl` / `mediaIdToken` / `mediaIdBase`
 * from the {@link getUploadLocations} response without pulling in a
 * full proto runtime.
 *
 * @param buf - Raw proto bytes.
 * @returns Read-only {@link ProtoNode} keyed by field number.
 *
 * @internal
 */
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

/**
 * Read a single proto varint from `buf` starting at `pos`. Returns the
 * decoded `bigint` value plus the new cursor position.
 *
 * @internal
 */
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
