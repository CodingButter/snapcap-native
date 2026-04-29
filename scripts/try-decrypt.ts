/**
 * Take Jamie's saved inbound message, find our recipient entry, and try
 * to decrypt the per-recipient wrapped CEK with various KDFs.
 *
 * Known inputs:
 *   - our identity (cleartext private key) from auth blob
 *   - sender public key (compressed) from f4.f3.f5.f3
 *   - our wrapped CEK (32 bytes) from f3.f99[i].f3 where i is the entry
 *     whose f1 matches SHA256(ourPubkey)[0:5]
 *
 * Try several KDF + cipher combinations until one produces sensible
 * plaintext.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius;
if (!fid) throw new Error("no fidelius in blob");
const myPriv = hexToBytes(fid.privateKey);
const myPub = hexToBytes(fid.publicKey);
const myPkidPrefix = createHash("sha256").update(myPub).digest().subarray(0, 5);
log(`our pkid prefix: ${Buffer.from(myPkidPrefix).toString("hex")}`);

// Find inbound proto file (Jamie's conv).
const inboundPath = "/tmp/inbox_8fee42df_eabd1d89.bin";
const data = readFileSync(inboundPath);
log(`inbound: ${data.byteLength} bytes`);

// Walk structure to extract: senderPub (compressed), our wrapped CEK,
// content ciphertext, IVs.
const top = new ProtoReader(new Uint8Array(data));
let body: Uint8Array | null = null;
for (let n = top.next(); n; n = top.next()) {
  if (n.field === 1 && n.wireType === 2) body = top.bytes();
  else top.skip(n.wireType);
}
if (!body) throw new Error("no top f1");
log(`body: ${body.byteLength}B`);

// Extract f3 (encryption envelope) and f4 (content).
let f3: Uint8Array | null = null;
let f4: Uint8Array | null = null;
const r1 = new ProtoReader(body);
for (let n = r1.next(); n; n = r1.next()) {
  if (n.field === 3 && n.wireType === 2) f3 = r1.bytes();
  else if (n.field === 4 && n.wireType === 2) f4 = r1.bytes();
  else r1.skip(n.wireType);
}
if (!f3 || !f4) throw new Error("missing f3 or f4");

// f3.f99 = recipient list. Find ours.
let myEntry: { pkid: Uint8Array; version: bigint; wrapped: Uint8Array } | null = null;
const r3 = new ProtoReader(f3);
for (let n = r3.next(); n; n = r3.next()) {
  if (n.field === 99 && n.wireType === 2) {
    const f99 = new ProtoReader(r3.bytes());
    for (let m = f99.next(); m; m = f99.next()) {
      if (m.field === 5 && m.wireType === 2) {
        const f99f5 = new ProtoReader(f99.bytes());
        for (let k = f99f5.next(); k; k = f99f5.next()) {
          if (k.field === 1 && k.wireType === 2) {
            const entry = new ProtoReader(f99f5.bytes());
            let pkid = new Uint8Array(0), version = 0n, wrapped = new Uint8Array(0);
            for (let e = entry.next(); e; e = entry.next()) {
              if (e.field === 1 && e.wireType === 2) pkid = entry.bytes();
              else if (e.field === 2 && e.wireType === 0) version = entry.varint();
              else if (e.field === 3 && e.wireType === 2) wrapped = entry.bytes();
              else entry.skip(e.wireType);
            }
            if (bufferEq(pkid, myPkidPrefix)) {
              myEntry = { pkid: new Uint8Array(pkid), version, wrapped: new Uint8Array(wrapped) };
            }
          } else f99f5.skip(k.wireType);
        }
      } else f99.skip(m.wireType);
    }
  } else r3.skip(n.wireType);
}
if (!myEntry) throw new Error("could not find recipient entry for our pkid");
log(`our entry: pkid=${Buffer.from(myEntry.pkid).toString("hex")} version=${myEntry.version} wrapped=${myEntry.wrapped.byteLength}B`);

// f4 — content envelope. Pull sender public key + content ciphertext.
let senderPubCompressed = new Uint8Array(0);
let contentCt = new Uint8Array(0);
let na: Uint8Array = new Uint8Array(0);
let secondField = new Uint8Array(0);
const r4 = new ProtoReader(f4);
for (let n = r4.next(); n; n = r4.next()) {
  if (n.field === 3 && n.wireType === 2) {
    const f4f3 = new ProtoReader(r4.bytes());
    for (let m = f4f3.next(); m; m = f4f3.next()) {
      if (m.field === 5 && m.wireType === 2) {
        const f4f3f5 = new ProtoReader(f4f3.bytes());
        for (let k = f4f3f5.next(); k; k = f4f3f5.next()) {
          if (k.field === 1 && k.wireType === 2) na = f4f3f5.bytes();
          else if (k.field === 2 && k.wireType === 2) secondField = f4f3f5.bytes();
          else if (k.field === 3 && k.wireType === 2) senderPubCompressed = f4f3f5.bytes();
          else f4f3f5.skip(k.wireType);
        }
      } else f4f3.skip(m.wireType);
    }
  } else if (n.field === 4 && n.wireType === 2) contentCt = r4.bytes();
  else r4.skip(n.wireType);
}
log(`sender pub compressed: ${senderPubCompressed.byteLength}B = ${Buffer.from(senderPubCompressed).toString("hex").slice(0, 32)}…`);
log(`na (12B): ${Buffer.from(na).toString("hex")}`);
log(`secondField (16B): ${Buffer.from(secondField).toString("hex")}`);
log(`content ciphertext: ${contentCt.byteLength}B = ${Buffer.from(contentCt).toString("hex")}`);

// Decompress P-256 sender pub (0x03 prefix → odd y, 0x02 → even y).
const senderPubUncompressed = decompressP256(senderPubCompressed);
log(`sender pub uncompressed: ${Buffer.from(senderPubUncompressed).toString("hex").slice(0, 40)}…`);

// ECDH shared secret with sender.
const myPrivKey = createPrivateKey({
  key: { kty: "EC", crv: "P-256",
    x: b64u(myPub.subarray(1, 33)),
    y: b64u(myPub.subarray(33, 65)),
    d: b64u(myPriv) },
  format: "jwk",
});
const senderPubKey = createPublicKey({
  key: { kty: "EC", crv: "P-256",
    x: b64u(senderPubUncompressed.subarray(1, 33)),
    y: b64u(senderPubUncompressed.subarray(33, 65)) },
  format: "jwk",
});
const shared = diffieHellman({ privateKey: myPrivKey, publicKey: senderPubKey });
log(`\nECDH shared secret: ${Buffer.from(shared).toString("hex")}`);

// Try a bunch of KDF/cipher combinations on the wrapped CEK.
// The wrapped CEK is 32 bytes — could be:
//   - AES-256-GCM(16B IV + 12B ct + ?B tag) somewhere, but 32 < 28+16
//   - AES-128-GCM(?? IV + ?? ct + 16B tag) → 16B encrypted CEK + 16B tag = 32B
//   - Raw XOR with derived key → 32B output (key-equivalent of CEK)
//
// Try AES-128-GCM first: 16B ciphertext + 16B tag.
const ct = myEntry.wrapped.subarray(0, 16);
const tag = myEntry.wrapped.subarray(16, 32);

const ivCandidates: Array<{ label: string; iv: Uint8Array }> = [
  { label: "na", iv: na },
  { label: "secondField", iv: secondField },
  { label: "secondField[0:12]", iv: secondField.subarray(0, 12) },
  { label: "zero12", iv: new Uint8Array(12) },
];

const kdfCandidates: Array<{ label: string; key: Uint8Array }> = [
  { label: "shared raw[0:16]", key: shared.subarray(0, 16) },
  { label: "sha256(shared)[0:16]", key: createHash("sha256").update(shared).digest().subarray(0, 16) },
  { label: "hkdf empty/empty 16", key: Buffer.from(hkdfSync("sha256", shared, new Uint8Array(0), new Uint8Array(0), 16)) },
  { label: "hkdf empty/fidelius 16", key: Buffer.from(hkdfSync("sha256", shared, new Uint8Array(0), new TextEncoder().encode("fidelius"), 16)) },
  { label: "hkdf na/empty 16", key: Buffer.from(hkdfSync("sha256", shared, na, new Uint8Array(0), 16)) },
  { label: "hkdf na/fidelius 16", key: Buffer.from(hkdfSync("sha256", shared, na, new TextEncoder().encode("fidelius"), 16)) },
];

// Also try with 32-byte (AES-256) keys and bigger info-string set.
const kdfSizes: Array<{ size: number; label: string }> = [
  { size: 16, label: "16" },
  { size: 32, label: "32" },
  { size: 48, label: "48" }, // 32B key + 16B IV maybe
];

const allKeys: Array<{ label: string; key: Uint8Array }> = [];
for (const sz of kdfSizes) {
  allKeys.push({ label: `shared[0:${sz.label}]`, key: shared.subarray(0, sz.size) });
  allKeys.push({ label: `sha256(shared)[0:${sz.label}]`, key: createHash("sha256").update(shared).digest().subarray(0, sz.size) });
  for (const salt of [
    { name: "empty", b: new Uint8Array(0) },
    { name: "na", b: na },
    { name: "secondField", b: secondField },
    { name: "myPkid", b: myPkidPrefix },
  ]) {
    for (const info of [
      { name: "empty", b: new Uint8Array(0) },
      { name: '"fidelius"', b: new TextEncoder().encode("fidelius") },
      { name: '"fidelius_phi"', b: new TextEncoder().encode("fidelius_phi") },
      { name: '"snap_phi"', b: new TextEncoder().encode("snap_phi") },
      { name: '"snapchat_e2ee"', b: new TextEncoder().encode("snapchat_e2ee") },
      { name: '"e2ee_chat"', b: new TextEncoder().encode("e2ee_chat") },
      { name: '"FIDELIUS_SNAP_PHI"', b: new TextEncoder().encode("FIDELIUS_SNAP_PHI") },
      { name: '"FIDELIUS_SNAP_INVERSE_PHI"', b: new TextEncoder().encode("FIDELIUS_SNAP_INVERSE_PHI") },
    ]) {
      try {
        allKeys.push({
          label: `hkdf(salt=${salt.name},info=${info.name})[0:${sz.label}]`,
          key: Buffer.from(hkdfSync("sha256", shared, salt.b, info.b, sz.size)),
        });
      } catch {}
    }
  }
}

const aads: Array<{ name: string; b: Uint8Array | null }> = [
  { name: "none", b: null },
  { name: "myPkid", b: myPkidPrefix },
  { name: "version=10", b: new Uint8Array([10]) },
  { name: "myPub65", b: myPub },
];

log(`\n--- attempting CEK unwrap (${allKeys.length} keys * ${ivCandidates.length} IVs * ${aads.length} AADs * 2 ciphers) ---`);
let any = 0;
for (const k of allKeys) {
  for (const iv of ivCandidates) {
    if (iv.iv.byteLength === 0) continue;
    for (const aad of aads) {
      for (const cipher of ["aes-128-gcm" as const, "aes-256-gcm" as const]) {
        const keyLen = cipher === "aes-128-gcm" ? 16 : 32;
        if (k.key.byteLength < keyLen) continue;
        try {
          const d = createDecipheriv(cipher, k.key.subarray(0, keyLen), iv.iv);
          if (aad.b) d.setAAD(aad.b);
          d.setAuthTag(tag);
          const cek = Buffer.concat([d.update(ct), d.final()]);
          log(`✅ ${cipher} | iv=${iv.label} | key=${k.label} | aad=${aad.name} → CEK ${cek.toString("hex")} (${cek.byteLength}B)`);
          any++;
        } catch {}
      }
    }
  }
}
if (!any) log(`❌ no AES-GCM unwrap combination matched (tried ${allKeys.length * ivCandidates.length * aads.length * 2})`);

// Also try AES-KW (key wrap, RFC 3394) with various keys
import { createDecipheriv as cdv } from "node:crypto";
log(`\n--- attempting AES-KW (key wrap) ---`);
for (const k of allKeys) {
  if (k.key.byteLength !== 16 && k.key.byteLength !== 32) continue;
  // Standard AES-KW expects 24B input → 16B output, or 40B → 32B, etc.
  // 32B input → 24B output. Wrong size for our 32B input. Skip in practice.
}

// CTR-mode no auth. wrapped[0:12] could be IV, wrapped[12:] the CEK.
log(`\n--- attempting AES-CTR (no auth) ---`);
for (const k of allKeys) {
  if (k.key.byteLength !== 16 && k.key.byteLength !== 32) continue;
  // Try with our IV candidates against the full 32-byte wrapped blob
  for (const iv of ivCandidates) {
    if (iv.iv.byteLength === 0) continue;
    const ivBuf = iv.iv.byteLength >= 16 ? iv.iv.subarray(0, 16) : Buffer.concat([Buffer.from(iv.iv), Buffer.alloc(16 - iv.iv.byteLength)]);
    try {
      const cipher = k.key.byteLength === 16 ? "aes-128-ctr" as const : "aes-256-ctr" as const;
      const d = cdv(cipher, k.key, ivBuf);
      const out = Buffer.concat([d.update(myEntry.wrapped), d.final()]);
      // Heuristic: a sensible CEK should look like high-entropy bytes,
      // not all-zero or printable. Just print all candidates and we'll
      // recognize the right one by trying to decrypt the content with it.
      const probablyKey = out.byteLength >= 16 && Buffer.from(out.subarray(0, 16)).every((b, i, arr) => i < 4 || b !== arr[i-1] || arr.filter(x=>x===b).length < 8);
      if (probablyKey) {
        log(`  ${cipher} | iv=${iv.label}(${ivBuf.byteLength}B) | key=${k.label}(${k.key.byteLength}B) → ${out.toString("hex").slice(0, 40)}…`);
      }
    } catch {}
  }
}

// ── helpers ──
function decompressP256(point: Uint8Array): Uint8Array {
  if (point.byteLength === 65 && point[0] === 0x04) return point;
  if (point.byteLength !== 33) throw new Error(`expected 33-byte compressed point, got ${point.byteLength}`);
  const prefix = point[0];
  if (prefix !== 0x02 && prefix !== 0x03) throw new Error(`bad compressed prefix ${prefix}`);
  // Use createPublicKey to do the decompression for us via SPKI import.
  const spki = Buffer.concat([
    Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
    Buffer.from(point),
  ]);
  const k = createPublicKey({ key: spki, format: "der", type: "spki" });
  const jwk = k.export({ format: "jwk" }) as { x: string; y: string };
  return new Uint8Array([
    0x04,
    ...Buffer.from(jwk.x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.x.length / 4) * 4, "="), "base64"),
    ...Buffer.from(jwk.y.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.y.length / 4) * 4, "="), "base64"),
  ]);
}

function bufferEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
