/**
 * Fidelius encrypt-side: wrap a per-message CEK to each recipient
 * device's public key (ECDH-P256 → KDF → AES-GCM), encrypt the
 * content with the CEK, and produce the wire-format envelope Snap
 * expects in CCM field 3.f99 + content field 4.f4.
 *
 * Used for both Fidelius text DMs (kind=149) and snaps (kind=122).
 * Text DMs differ only in the destination kind and the content payload
 * shape (no media-id reference).
 *
 * The exact KDF/AAD bytes Snap uses for the per-recipient CEK wrap
 * aren't yet pinned down — we couldn't decrypt an inbound message
 * with any of the standard 24 KDF combos. This module exposes the
 * KDF as an `EncryptOpts` argument so we can iterate empirically:
 * send a snap to a real recipient with a candidate KDF, see if their
 * app displays the content, repeat until something works.
 *
 * Defaults are: HKDF-SHA256 over the ECDH shared secret with empty
 * salt + UTF-8 "fidelius" info, AES-128-GCM with 12-byte `na` nonce,
 * no AAD, 16-byte authTag. The 32-byte wrapped CEK is laid out as
 * 16 bytes ciphertext || 16 bytes tag.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  randomBytes,
} from "node:crypto";
import type { FideliusIdentity } from "../auth/fidelius-mint.ts";
import { ProtoWriter } from "../transport/proto-encode.ts";

export type FriendDevice = {
  /** 65-byte uncompressed P-256 public key (0x04 prefix). */
  publicKey: Uint8Array;
  /** Protocol version — currently always 10. */
  version: number;
};

export type EncryptOpts = {
  /** HKDF salt for deriving the per-recipient wrap key. Default: empty. */
  hkdfSalt?: Uint8Array;
  /** HKDF info. Default: UTF-8 "fidelius". */
  hkdfInfo?: Uint8Array;
  /** AES-GCM additional authenticated data. Default: none. */
  aad?: Uint8Array;
  /** Cipher choice. Default: aes-128-gcm with 16-byte CEK. */
  cipher?: "aes-128-gcm" | "aes-256-gcm";
};

export type FideliusEncryptedSnap = {
  /** Per-recipient envelope, ready to write as f3.f99 inside a CCM. */
  recipientsBlob: Uint8Array;
  /** The "PHI prelude" carrying na + version + sender pubkey, ready
   *  to write as f4.f3 inside a CCM. */
  phiPrelude: Uint8Array;
  /** Encrypted content bytes, ready to write as f4.f4. */
  contentCiphertext: Uint8Array;
  /** Random per-recipient `na` nonce we used (12 bytes). */
  na: Uint8Array;
  /** Per-message symmetric key the content was encrypted under. */
  cek: Uint8Array;
  /** Content IV used to encrypt the plaintext (12 bytes). */
  contentIv: Uint8Array;
};

/**
 * Build the Fidelius envelope and content ciphertext for a message
 * sent from `sender` to a list of recipient devices.
 *
 * Returns the three byte-strings needed to assemble a CCM:
 *   recipientsBlob  → CCM f3.f99 sub-message (the `f5` containing
 *                    each {pkid, version, wrappedCEK})
 *   phiPrelude      → CCM f4.f3 sub-message (na, second 16B, sender
 *                    pubkey compressed, version)
 *   contentCiphertext → CCM f4.f4 raw bytes
 */
export function encryptFideliusSnap(
  plaintext: Uint8Array,
  sender: FideliusIdentity,
  recipients: FriendDevice[],
  opts: EncryptOpts = {},
): FideliusEncryptedSnap {
  const cipher = opts.cipher ?? "aes-128-gcm";
  const cekLen = cipher === "aes-128-gcm" ? 16 : 32;
  const cek = randomBytes(cekLen);
  const contentIv = randomBytes(12);
  const na = randomBytes(12);

  // Encrypt content with the CEK.
  const contentCipher = createCipheriv(cipher, cek, contentIv);
  if (opts.aad) contentCipher.setAAD(opts.aad);
  const ctBody = Buffer.concat([contentCipher.update(plaintext), contentCipher.final()]);
  const ctTag = contentCipher.getAuthTag();
  const contentCiphertext = Buffer.concat([ctBody, ctTag]);

  // Compress sender pubkey (65B uncompressed → 33B compressed for the wire).
  const senderPubCompressed = compressP256(sender.cleartextPublicKey);

  // Wrap the CEK to each recipient.
  const senderPriv = loadPrivateKey(sender);
  const wrappedEntries: Uint8Array[] = [];
  for (const device of recipients) {
    const recipientPub = createPublicKey({
      key: {
        kty: "EC", crv: "P-256",
        x: b64u(device.publicKey.subarray(1, 33)),
        y: b64u(device.publicKey.subarray(33, 65)),
      },
      format: "jwk",
    });
    const shared = diffieHellman({ privateKey: senderPriv, publicKey: recipientPub });
    const wrapKey = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        opts.hkdfSalt ?? new Uint8Array(0),
        opts.hkdfInfo ?? new TextEncoder().encode("fidelius"),
        cekLen,
      ),
    );
    const wrap = createCipheriv(cipher, wrapKey, na);
    if (opts.aad) wrap.setAAD(opts.aad);
    const wrapCt = Buffer.concat([wrap.update(cek), wrap.final()]);
    const wrapTag = wrap.getAuthTag();
    const wrapped = Buffer.concat([wrapCt, wrapTag]); // 16+16 = 32 bytes for AES-128

    // pkid = SHA256(recipientPubkey)[0:5]
    const pkid = createHash("sha256").update(device.publicKey).digest().subarray(0, 5);

    // entry = { f1 bytes(5) pkid, f2 varint version, f3 bytes(N) wrapped }
    const entryW = new ProtoWriter();
    entryW.fieldBytes(1, pkid);
    entryW.fieldVarint(2, device.version);
    entryW.fieldBytes(3, new Uint8Array(wrapped));
    wrappedEntries.push(entryW.finish());
  }

  // recipientsBlob shape (lifted from inbound capture):
  //   f99 sub:
  //     f5 sub:
  //       repeated f1 sub: <entry>
  //
  // We only emit the f5 sub-content here — caller wraps it under f99
  // when building the CCM.
  const recipientsW = new ProtoWriter();
  recipientsW.fieldMessage(5, (m) => {
    for (const e of wrappedEntries) {
      m.fieldBytes(1, e);
    }
  });
  const recipientsBlob = recipientsW.finish();

  // phiPrelude shape:
  //   f5 sub:
  //     f1 bytes(12) = na
  //     f2 bytes(16) = ?  (we send a random 16B blob — its meaning is
  //                       still TBC; inbound captures had 16 high-entropy
  //                       bytes here)
  //     f3 bytes(33) = sender pubkey compressed
  //     f4 varint    = version (10)
  const secondField = randomBytes(16);
  const phiW = new ProtoWriter();
  phiW.fieldMessage(5, (m) => {
    m.fieldBytes(1, na);
    m.fieldBytes(2, new Uint8Array(secondField));
    m.fieldBytes(3, senderPubCompressed);
    m.fieldVarint(4, sender.version);
  });
  const phiPrelude = phiW.finish();

  return {
    recipientsBlob,
    phiPrelude,
    contentCiphertext: new Uint8Array(contentCiphertext),
    na,
    cek: new Uint8Array(cek),
    contentIv,
  };
}

// ── helpers ────────────────────────────────────────────────────────

function loadPrivateKey(id: FideliusIdentity) {
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64u(id.cleartextPublicKey.subarray(1, 33)),
      y: b64u(id.cleartextPublicKey.subarray(33, 65)),
      d: b64u(id.cleartextPrivateKey),
    },
    format: "jwk",
  });
}

function compressP256(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.byteLength !== 65 || uncompressed[0] !== 0x04) {
    throw new Error(`expected 65-byte uncompressed P-256 (0x04 prefix), got ${uncompressed.byteLength}B`);
  }
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);
  // Compressed prefix: 0x02 if y is even, 0x03 if y is odd.
  const yLastByte = y[y.byteLength - 1] ?? 0;
  const prefix = yLastByte & 1 ? 0x03 : 0x02;
  const out = new Uint8Array(33);
  out[0] = prefix;
  out.set(x, 1);
  return out;
}

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
