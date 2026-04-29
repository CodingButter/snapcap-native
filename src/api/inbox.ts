/**
 * Inbox: fetch and decrypt incoming messages.
 *
 * Two layers:
 *   1. `queryMessages` — raw gRPC call to MessagingCoreService.QueryMessages.
 *      Returns the server's framed response payload. Parsing is permissive
 *      because we haven't yet captured a non-empty response in the wild.
 *   2. `decryptFidelius` — given a captured FideliusEncryption blob and
 *      our SDK-side identity, find the per-recipient entry encrypted to
 *      our identityKeyId and decrypt it (ECDH-P256 → HKDF → AES-GCM).
 *      Default KDF is HKDF-SHA256 with empty salt + "fidelius" info; we'll
 *      iterate parameters once we have a real ciphertext to attack.
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
} from "node:crypto";
import { ProtoWriter, ProtoReader, uuidToBytes, bytesToUuid } from "../transport/proto-encode.ts";
import type { GrpcMethodDesc } from "../transport/grpc-web.ts";
import type { FideliusIdentity } from "../auth/fidelius-mint.ts";

const SERVICE = { serviceName: "messagingcoreservice.MessagingCoreService" };

// ── QueryMessages ─────────────────────────────────────────────────────

/**
 * Captured request shape (from inbox-fetch HARs):
 *   f1 varint  — page size limit (saw 21)
 *   f2 sub: f1 = bytes16 conversationId
 *   f3 varint  — secondary limit (saw 100, possibly max age in days?)
 *   f4 sub: f1 = bytes16 selfUserId
 */
export type QueryMessagesRequest = {
  conversationId: string;
  selfUserId: string;
  /** Max messages per call. Browser sends 21. */
  limit?: number;
  /** Secondary limit — captured value 100. Meaning unknown. */
  secondary?: number;
};

export type QueryMessagesResponse = {
  /** Raw response bytes, returned for empirical decoding while the
   *  full proto shape is being mapped. */
  raw: Uint8Array;
};

export const QueryMessagesDesc: GrpcMethodDesc<QueryMessagesRequest, QueryMessagesResponse> = {
  methodName: "QueryMessages",
  service: SERVICE,
  requestType: {
    serializeBinary(this: QueryMessagesRequest): Uint8Array {
      const w = new ProtoWriter();
      w.fieldVarint(1, this.limit ?? 21);
      w.fieldMessage(2, (m) => m.fieldBytes(1, uuidToBytes(this.conversationId)));
      w.fieldVarint(3, this.secondary ?? 100);
      w.fieldMessage(4, (m) => m.fieldBytes(1, uuidToBytes(this.selfUserId)));
      return w.finish();
    },
  },
  responseType: {
    decode(bytes: Uint8Array): QueryMessagesResponse {
      return { raw: new Uint8Array(bytes) };
    },
  },
};

export type Rpc = {
  unary: (method: GrpcMethodDesc<unknown, unknown>, request: unknown) => Promise<unknown>;
};

/**
 * Fetch up to `limit` recent messages for `conversationId`. Returns the
 * raw response bytes — caller is responsible for walking the proto
 * (we'll add a typed decoder once we've seen a non-empty response).
 */
export async function queryMessages(rpc: Rpc, req: QueryMessagesRequest): Promise<QueryMessagesResponse> {
  return (await rpc.unary(
    QueryMessagesDesc as unknown as GrpcMethodDesc<unknown, unknown>,
    req,
  )) as QueryMessagesResponse;
}

// ── Fidelius decryption ───────────────────────────────────────────────

/**
 * Per-recipient entry in a FideliusEncryption envelope.
 * Wire shape (from chat-bundle protos):
 *   1: bytes recipientKey   — recipient device's identityKeyId
 *   2: bytes na             — nonce-A (per-recipient salt)
 *   3: bytes phi            — encrypted CEK envelope ("PHI")
 *   4: bytes tag            — AEAD authentication tag
 *   5: { 1: bytes16 senderUserId }
 *   6: { 1: bytes16 recipientUserId }
 *   7: uint32 recipientVersion
 */
export type FideliusRecipientInfo = {
  recipientKey: Uint8Array;
  na: Uint8Array;
  phi: Uint8Array;
  tag: Uint8Array;
  senderUserId?: string;
  recipientUserId?: string;
  recipientVersion: number;
};

/**
 * FideliusEncryption envelope.
 * Wire shape:
 *   1: bytes snapKey        — wrapped CEK
 *   2: bytes snapIv         — IV used to wrap the CEK
 *   3: bool retried
 *   4: uint32 version
 *   5: bytes senderOutBeta
 *   6: repeated FideliusRecipientInfo
 */
export type FideliusEnvelope = {
  snapKey: Uint8Array;
  snapIv: Uint8Array;
  retried: boolean;
  version: number;
  senderOutBeta: Uint8Array;
  recipients: FideliusRecipientInfo[];
};

/** Decode a FideliusEncryption proto into a typed envelope. */
export function decodeFideliusEnvelope(bytes: Uint8Array): FideliusEnvelope {
  const r = new ProtoReader(bytes);
  const env: FideliusEnvelope = {
    snapKey: new Uint8Array(0),
    snapIv: new Uint8Array(0),
    retried: false,
    version: 0,
    senderOutBeta: new Uint8Array(0),
    recipients: [],
  };
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) env.snapKey = new Uint8Array(r.bytes());
    else if (n.field === 2 && n.wireType === 2) env.snapIv = new Uint8Array(r.bytes());
    else if (n.field === 3 && n.wireType === 0) env.retried = r.varint() !== 0n;
    else if (n.field === 4 && n.wireType === 0) env.version = Number(r.varint());
    else if (n.field === 5 && n.wireType === 2) env.senderOutBeta = new Uint8Array(r.bytes());
    else if (n.field === 6 && n.wireType === 2) env.recipients.push(decodeRecipientInfo(r.bytes()));
    else r.skip(n.wireType);
  }
  return env;
}

function decodeRecipientInfo(bytes: Uint8Array): FideliusRecipientInfo {
  const r = new ProtoReader(bytes);
  const info: FideliusRecipientInfo = {
    recipientKey: new Uint8Array(0),
    na: new Uint8Array(0),
    phi: new Uint8Array(0),
    tag: new Uint8Array(0),
    recipientVersion: 0,
  };
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) info.recipientKey = new Uint8Array(r.bytes());
    else if (n.field === 2 && n.wireType === 2) info.na = new Uint8Array(r.bytes());
    else if (n.field === 3 && n.wireType === 2) info.phi = new Uint8Array(r.bytes());
    else if (n.field === 4 && n.wireType === 2) info.tag = new Uint8Array(r.bytes());
    else if (n.field === 5 && n.wireType === 2) {
      const sub = new ProtoReader(r.bytes());
      const idMsg = sub.next();
      if (idMsg && idMsg.field === 1 && idMsg.wireType === 2) {
        info.senderUserId = bytesToUuid(sub.bytes());
      }
    } else if (n.field === 6 && n.wireType === 2) {
      const sub = new ProtoReader(r.bytes());
      const idMsg = sub.next();
      if (idMsg && idMsg.field === 1 && idMsg.wireType === 2) {
        info.recipientUserId = bytesToUuid(sub.bytes());
      }
    } else if (n.field === 7 && n.wireType === 0) {
      info.recipientVersion = Number(r.varint());
    } else r.skip(n.wireType);
  }
  return info;
}

/**
 * Find the recipient entry encrypted to our identity and decrypt it.
 *
 * KDF defaults are placeholder ("standard ECDH+HKDF-SHA256, empty salt,
 * 'fidelius' info, AES-256-GCM"). Once we have a known-good ciphertext
 * we'll iterate these until decryption produces sensible plaintext.
 */
export type DecryptOpts = {
  /** Sender's public key (65-byte SEC1 uncompressed P-256). */
  senderPublicKey: Uint8Array;
  /** Override HKDF salt; default empty Uint8Array(0). */
  salt?: Uint8Array;
  /** Override HKDF info; default UTF-8 "fidelius". */
  info?: Uint8Array;
};

export type DecryptResult = {
  /** Wrapped CEK + IV from the envelope's PHI proto, decrypted. */
  cek: Uint8Array;
  cekIv: Uint8Array;
  /** Recipient entry that we decrypted (mostly for tracing). */
  matchedRecipient: FideliusRecipientInfo;
};

export function decryptFideliusEnvelope(
  envelope: FideliusEnvelope,
  identity: FideliusIdentity,
  opts: DecryptOpts,
): DecryptResult {
  // Find the entry whose recipientKey matches our identityKeyId.
  const ours = envelope.recipients.find(
    (r) => bytesEqual(r.recipientKey, identity.identityKeyId),
  );
  if (!ours) {
    throw new Error(
      `no Fidelius recipient entry matched our identityKeyId (${envelope.recipients.length} recipients)`,
    );
  }

  // ECDH between our private key and the sender's public key.
  const ourPriv = createPrivateKey({
    key: {
      kty: "EC", crv: "P-256",
      x: b64u(identity.cleartextPublicKey.slice(1, 33)),
      y: b64u(identity.cleartextPublicKey.slice(33, 65)),
      d: b64u(identity.cleartextPrivateKey),
    },
    format: "jwk",
  });
  const senderPub = createPublicKey({
    key: {
      kty: "EC", crv: "P-256",
      x: b64u(opts.senderPublicKey.slice(1, 33)),
      y: b64u(opts.senderPublicKey.slice(33, 65)),
    },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey: ourPriv, publicKey: senderPub });

  // HKDF with placeholder salt/info — TBC against a known ciphertext.
  const salt = opts.salt ?? new Uint8Array(0);
  const info = opts.info ?? new TextEncoder().encode("fidelius");
  const wrappingKey = Buffer.from(hkdfSync("sha256", shared, salt, info, 32));

  // AES-256-GCM decrypt: na = IV, tag = authTag, phi = ciphertext.
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, ours.na);
  decipher.setAuthTag(ours.tag);
  const phiPlaintext = Buffer.concat([decipher.update(ours.phi), decipher.final()]);

  // PHI proto: { 1: bytes nonce, 2: bytes senderPublicKeyIdentifier, 16: bytes cekPlaintext }
  const phiR = new ProtoReader(new Uint8Array(phiPlaintext));
  let cekPlaintext = new Uint8Array(0);
  for (let n = phiR.next(); n; n = phiR.next()) {
    if (n.field === 16 && n.wireType === 2) cekPlaintext = new Uint8Array(phiR.bytes());
    else phiR.skip(n.wireType);
  }

  return {
    cek: cekPlaintext,
    cekIv: envelope.snapIv,
    matchedRecipient: ours,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
