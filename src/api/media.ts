/**
 * Media DM send pipeline.
 *
 * Three-step sequence:
 *   1. POST MediaDeliveryService.getUploadLocations  → returns a signed
 *      S3 PUT URL + a media-id we'll reference from the message.
 *   2. PUT the AES-256-CBC encrypted image bytes to that URL.
 *   3. POST MessagingCoreService.CreateContentMessage with the media-id +
 *      key + IV embedded so the recipient can fetch and decrypt.
 *
 * Wire shape lifted from real captured traffic. The encryption key + IV
 * travel inside the message body — Snap's regular media path is "encrypted
 * at the CDN, decrypted by the recipient with the per-message key the
 * server passes through." (Fidelius E2E is a *separate* layer that
 * additionally encrypts the message body itself; this module skips it.
 * Recipients see images sent via this path the same way they see images
 * sent from any non-E2E client.)
 */
import { randomBytes, createCipheriv } from "node:crypto";
import { ProtoWriter, uuidToBytes } from "../transport/proto-encode.ts";
import type { GrpcMethodDesc } from "../transport/grpc-web.ts";

// ── 1. getUploadLocations ─────────────────────────────────────────────

export type UploadLocation = {
  /** Pre-signed S3 PUT URL — valid for ~24h. */
  putUrl: string;
  /** Token with `_<index>` suffix referenced from CreateContentMessage. */
  mediaIdToken: string;
  /** Base media-id (no suffix). */
  mediaIdBase: string;
};

const GET_UPLOAD_LOCATIONS_DESC: GrpcMethodDesc<Record<string, unknown>, Record<string, unknown>> = {
  methodName: "getUploadLocations",
  service: { serviceName: "snapchat.content.v2.MediaDeliveryService" },
  requestType: {
    serializeBinary(): Uint8Array {
      // Captured request body (10 bytes after the 5-byte gRPC frame):
      //   field 2 = 1, field 4 = 1, field 7 = bytes(1)=00, field 16 = 1
      // Variants observed (field 7 byte differs between media kinds); we
      // hard-code the image variant for now.
      const w = new ProtoWriter();
      w.fieldVarint(2, 1);
      w.fieldVarint(4, 1);
      w.fieldBytes(7, new Uint8Array([0]));
      w.fieldVarint(16, 1);
      return w.finish();
    },
  },
  responseType: {
    decode: (bytes: Uint8Array): Record<string, unknown> => {
      // The bundle's protoc-gen client decodes this fully; we hand-walk
      // just the fields we need.
      // Wire shape (real capture):
      //   1: { 1: signed-PUT-URL, 2: { 1: expires-unix-s }, 3: { 1: ttl-s },
      //        4: { 3: { 1: token "<base>_<idx>", 2: { 2: base, 6: kind, 9, 10, 11, 12 } }, 5: 1 } }
      // Helper not exported here — see `getUploadLocations(rpc)` below for parsing.
      return { __raw: bytes };
    },
  },
};

export type Rpc = {
  unary: (
    method: GrpcMethodDesc<unknown, unknown>,
    request: unknown,
  ) => Promise<unknown>;
};

export async function getUploadLocations(rpc: Rpc): Promise<UploadLocation> {
  const result = (await rpc.unary(
    GET_UPLOAD_LOCATIONS_DESC as unknown as GrpcMethodDesc<unknown, unknown>,
    {},
  )) as { __raw?: Uint8Array };
  if (!result.__raw) throw new Error("getUploadLocations response missing raw bytes");
  return parseUploadLocationsResponse(result.__raw);
}

function parseUploadLocationsResponse(buf: Uint8Array): UploadLocation {
  // Tolerant manual walk — Snap may add fields, we extract only what we need.
  const w = walkProto(buf);
  const top = w.field(1)?.message;
  if (!top) throw new Error("getUploadLocations response: missing field 1");
  const putUrl = top.field(1)?.string ?? "";
  const tokenMsg = top.field(4)?.message?.field(3)?.message;
  const mediaIdToken = tokenMsg?.field(1)?.string ?? "";
  const mediaIdBase = tokenMsg?.field(2)?.message?.field(2)?.string ?? "";
  if (!putUrl || !mediaIdToken || !mediaIdBase) {
    throw new Error(`getUploadLocations response: incomplete (url=${!!putUrl}, token=${!!mediaIdToken}, base=${!!mediaIdBase})`);
  }
  return { putUrl, mediaIdToken, mediaIdBase };
}

// ── 2. AES-256-CBC encryption + upload ────────────────────────────────

export type EncryptedMedia = {
  ciphertext: Uint8Array;
  /** 32 bytes AES-256 key. */
  key: Uint8Array;
  /** 16 bytes IV. */
  iv: Uint8Array;
};

export function encryptMedia(plaintext: Uint8Array): EncryptedMedia {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: new Uint8Array(ciphertext), key: new Uint8Array(key), iv: new Uint8Array(iv) };
}

export async function uploadEncrypted(
  putUrl: string,
  ciphertext: Uint8Array,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
  // Match the headers Chrome actually sends. The pre-signed URL already
  // carries x-amz-acl in its query string; sending it as a header would
  // change the canonical request and break the AWS4 signature → 404.
  const resp = await fetchImpl(putUrl, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      origin: "https://www.snapchat.com",
      referer: "https://www.snapchat.com/",
    },
    body,
  });
  if (resp.status !== 200) {
    throw new Error(`media upload failed: HTTP ${resp.status} ${await resp.text().catch(() => "")}`);
  }
}

// ── 3. CreateContentMessage (media variant) ───────────────────────────

export type SendImageRequest = {
  senderUserId: string;
  conversationId: string;
  width: number;
  height: number;
  /** Token from getUploadLocations — e.g. "wO87suY3U6Ss473nIx9ba_1". */
  mediaIdToken: string;
  /** Base media-id without `_<idx>` suffix. */
  mediaIdBase: string;
  /** AES-256 key (32 bytes). */
  encryptionKey: Uint8Array;
  /** AES IV (16 bytes). */
  encryptionIv: Uint8Array;
  /** int64 message ID — defaults to a timestamp+random. */
  messageId?: bigint;
  /** Idempotency UUID — defaults to a fresh random. */
  clientMessageId?: string;
};

const CREATE_CONTENT_MESSAGE_MEDIA_DESC: GrpcMethodDesc<SendImageRequest, Record<string, unknown>> = {
  methodName: "CreateContentMessage",
  service: { serviceName: "messagingcoreservice.MessagingCoreService" },
  requestType: {
    serializeBinary(this: SendImageRequest): Uint8Array {
      // Wire shape (image DM, derived from captured 358-byte body):
      //   1: { 1: bytes16 senderUserId }
      //   2: int64 messageId
      //   3: { 1: { 1: { 1: bytes16 conversationId }, 2: int=111 } }   ← DM-with-media destination
      //   4: {
      //     2: int=2                                      ← content kind = MEDIA
      //     4: { 3: { 3: { 8:2, 4:{6:1,10:"1",8:2}, 5: media-descriptor, 13: bytes(0), 17:{4:ts}, 22:{1:7} } } }
      //     5: { 1: { 3: { 1: token, 2: { 2: base, 6:bytes(04), 9:1, 10:11, 12:1 } }, 8:2 } }
      //     6: bytes(0)
      //     7: int=2
      //   }
      //   8: { 1: { 1: bytes16 clientMessageId } }
      const w = new ProtoWriter();
      w.fieldMessage(1, (s) => s.fieldBytes(1, uuidToBytes(this.senderUserId)));
      w.fieldVarint(2, this.messageId ?? randomInt64Positive());

      // Destination: DM-with-media (kind=111 — observed in real capture).
      w.fieldMessage(3, (dest) => {
        dest.fieldMessage(1, (inner) => {
          inner.fieldMessage(1, (cid) => cid.fieldBytes(1, uuidToBytes(this.conversationId)));
          inner.fieldVarint(2, 111);
        });
      });

      // Content
      w.fieldMessage(4, (content) => {
        content.fieldVarint(2, 2);                // kind = MEDIA
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
                      dim.fieldVarint(1, this.width);
                      dim.fieldVarint(2, this.height);
                    });
                    d2.fieldBytes(18, new Uint8Array(0));
                    // Encryption key + IV — Snap stores them TWICE in the
                    // descriptor: field 4 as base64 strings, field 19 as raw
                    // bytes. Different recipient clients read different
                    // fields; both must carry the SAME values or the
                    // recipient that reads field 19 sees "tap to view"
                    // followed by a decryption failure.
                    d2.fieldMessage(4, (keys) => {
                      keys.fieldString(1, btoa(String.fromCharCode(...this.encryptionKey)));
                      keys.fieldString(2, btoa(String.fromCharCode(...this.encryptionIv)));
                    });
                    d2.fieldMessage(19, (alt) => {
                      alt.fieldBytes(1, this.encryptionKey);
                      alt.fieldBytes(2, this.encryptionIv);
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

        // Media reference: ties to the uploaded blob.
        content.fieldMessage(5, (ref) => {
          ref.fieldMessage(1, (r1) => {
            r1.fieldMessage(3, (r3) => {
              r3.fieldString(1, this.mediaIdToken);
              r3.fieldMessage(2, (r3b) => {
                r3b.fieldString(2, this.mediaIdBase);
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

      // Idempotency
      w.fieldMessage(8, (cm) => {
        cm.fieldMessage(1, (id) =>
          id.fieldBytes(1, uuidToBytes(this.clientMessageId ?? crypto.randomUUID())),
        );
      });
      return w.finish();
    },
  },
  responseType: {
    decode: (_b: Uint8Array): Record<string, unknown> => ({}),
  },
};

function randomInt64Positive(): bigint {
  const high = BigInt(Date.now()) << 16n;
  const low = BigInt(Math.floor(Math.random() * 0xffff));
  return high | low;
}

// ── 4. Top-level send-image helper ────────────────────────────────────

export type SendImageOpts = {
  /** Image bytes (PNG, JPEG, WebP, etc.) — width/height parsed from the file. */
  bytes: Uint8Array;
  /** Override dimensions if the image format isn't auto-detectable. */
  width?: number;
  height?: number;
};

/**
 * Orchestrate the full image-send pipeline:
 *   1. Get a signed S3 PUT URL + media-id.
 *   2. Encrypt the image bytes (AES-256-CBC, fresh random key+IV).
 *   3. PUT ciphertext to S3.
 *   4. POST CreateContentMessage with media-id + key + IV.
 */
export async function sendImage(
  rpc: Rpc,
  fetchImpl: typeof fetch,
  senderUserId: string,
  conversationId: string,
  opts: SendImageOpts,
): Promise<void> {
  const { width, height } = parseImageDimensions(opts.bytes, opts);

  const loc = await getUploadLocations(rpc);
  const enc = encryptMedia(opts.bytes);
  await uploadEncrypted(loc.putUrl, enc.ciphertext, fetchImpl);

  await rpc.unary(
    CREATE_CONTENT_MESSAGE_MEDIA_DESC as unknown as GrpcMethodDesc<unknown, unknown>,
    {
      senderUserId,
      conversationId,
      width,
      height,
      mediaIdToken: loc.mediaIdToken,
      mediaIdBase: loc.mediaIdBase,
      encryptionKey: enc.key,
      encryptionIv: enc.iv,
    } satisfies SendImageRequest,
  );
}

/**
 * Parse width/height from a PNG/JPEG/WebP header.
 * Caller can override via opts.width / opts.height for unsupported formats.
 */
function parseImageDimensions(
  bytes: Uint8Array,
  opts: { width?: number; height?: number },
): { width: number; height: number } {
  if (opts.width && opts.height) return { width: opts.width, height: opts.height };
  // PNG: bytes 16..24 are width, height (BE u32) inside the IHDR chunk.
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // JPEG: walk segments looking for SOF0/SOF2.
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.byteLength) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      if (marker === 0xc0 || marker === 0xc2) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + i + 5, 4);
        return { width: dv.getUint16(2, false), height: dv.getUint16(0, false) };
      }
      const segLen = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      i += 2 + segLen;
    }
  }
  if (opts.width || opts.height) return { width: opts.width ?? 0, height: opts.height ?? 0 };
  throw new Error("Could not parse image dimensions; pass opts.width and opts.height");
}

// ── tiny tolerant proto walker (read-only) ─────────────────────────────

type ProtoNode = {
  /** Get the first sub-field with the given number. */
  field(n: number): { string?: string; bytes?: Uint8Array; varint?: bigint; message?: ProtoNode } | undefined;
};

function walkProto(buf: Uint8Array): ProtoNode {
  // Pre-index every field we encounter at this nesting level.
  type Entry = { wireType: number; bytes?: Uint8Array; varint?: bigint };
  const fields: Map<number, Entry[]> = new Map();
  let pos = 0;
  while (pos < buf.byteLength) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    const list = fields.get(fieldNum) ?? [];
    if (wireType === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      list.push({ wireType, varint: v });
    } else if (wireType === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      const slice = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
      list.push({ wireType, bytes: slice });
    } else if (wireType === 1) {
      pos += 8; // skip
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
    fields.set(fieldNum, list);
  }
  return {
    field(n: number) {
      const e = fields.get(n)?.[0];
      if (!e) return undefined;
      if (e.bytes) {
        const b = e.bytes;
        return {
          bytes: b,
          string: new TextDecoder().decode(b),
          message: walkProto(b),
        };
      }
      return { varint: e.varint };
    },
  };
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.byteLength) {
    const b = buf[pos++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  return [result, pos];
}
