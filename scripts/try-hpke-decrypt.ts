/**
 * Try HPKE-based decrypt of Jamie's inbound message. The libclient.so
 * mentions "HPKE-v1" so Fidelius likely uses RFC 9180 HPKE.
 *
 * Layout hypothesis:
 *   - enc (encapsulated sender ephemeral pub) = f4.f3.f5.f3 (33B compressed P-256)
 *   - per-recipient ct||tag = f3.f99.f5.f1[i].f3 (32B = 16B ct + 16B tag)
 *   - HPKE single-shot Open with mode=base, suite=DHKEM(P-256,HKDF-SHA256)+HKDF-SHA256+AES-128-GCM
 *   - info = ??  (try FIDELIUS_SNAP_PHI / FIDELIUS_SNAP_INVERSE_PHI / others)
 *   - aad = ??  (try empty / sender pubkey / na)
 *
 * If a candidate HPKE decrypt produces 16 bytes, that's our CEK; verify
 * by AES-128-GCM-decrypting the content with key=CEK, IV=na, then check
 * if the result is printable text.
 */
import { CipherSuite, KemId, KdfId, AeadId } from "hpke-js";
import { createDecipheriv, createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius;
if (!fid) throw new Error("no fidelius in blob");
const myPriv = hexToBytes(fid.privateKey);
const myPub = hexToBytes(fid.publicKey);
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);
log(`my pkid: ${Buffer.from(myPkid).toString("hex")}`);

const data = readFileSync("/tmp/inbox_8fee42df.bin");
const top = new ProtoReader(new Uint8Array(data));
let f1: Uint8Array | null = null;
for (let n = top.next(); n; n = top.next()) {
  if (n.field === 1 && n.wireType === 2) f1 = top.bytes();
  else top.skip(n.wireType);
}
if (!f1) throw new Error("no f1");

let f3: Uint8Array | null = null, f4: Uint8Array | null = null;
const r1 = new ProtoReader(f1);
for (let n = r1.next(); n; n = r1.next()) {
  if (n.field === 3 && n.wireType === 2) f3 = r1.bytes();
  else if (n.field === 4 && n.wireType === 2) f4 = r1.bytes();
  else r1.skip(n.wireType);
}
if (!f3 || !f4) throw new Error("missing f3/f4");

// Find OUR recipient entry.
let myCt: Uint8Array | null = null;
const r3 = new ProtoReader(f3);
for (let n = r3.next(); n; n = r3.next()) {
  if (n.field === 99 && n.wireType === 2) {
    const f99 = new ProtoReader(r3.bytes());
    for (let m = f99.next(); m; m = f99.next()) {
      if (m.field === 5 && m.wireType === 2) {
        const f99f5 = new ProtoReader(f99.bytes());
        for (let k = f99f5.next(); k; k = f99f5.next()) {
          if (k.field === 1 && k.wireType === 2) {
            const e = new ProtoReader(f99f5.bytes());
            let pkid = new Uint8Array(0), wrapped = new Uint8Array(0);
            for (let f = e.next(); f; f = e.next()) {
              if (f.field === 1 && f.wireType === 2) pkid = e.bytes();
              else if (f.field === 3 && f.wireType === 2) wrapped = e.bytes();
              else e.skip(f.wireType);
            }
            if (Buffer.from(pkid).equals(Buffer.from(myPkid))) myCt = new Uint8Array(wrapped);
          } else f99f5.skip(k.wireType);
        }
      } else f99.skip(m.wireType);
    }
  } else r3.skip(n.wireType);
}
if (!myCt) throw new Error("no recipient entry for my pkid");
log(`my wrapped CEK (32B): ${Buffer.from(myCt).toString("hex")}`);

// Pull encapsulated sender pubkey and content.
let enc = new Uint8Array(0), na = new Uint8Array(0), secondField = new Uint8Array(0), contentCt = new Uint8Array(0);
const r4 = new ProtoReader(f4);
for (let n = r4.next(); n; n = r4.next()) {
  if (n.field === 3 && n.wireType === 2) {
    const f4f3 = new ProtoReader(r4.bytes());
    for (let m = f4f3.next(); m; m = f4f3.next()) {
      if (m.field === 5 && m.wireType === 2) {
        const inner = new ProtoReader(f4f3.bytes());
        for (let k = inner.next(); k; k = inner.next()) {
          if (k.field === 1 && k.wireType === 2) na = inner.bytes();
          else if (k.field === 2 && k.wireType === 2) secondField = inner.bytes();
          else if (k.field === 3 && k.wireType === 2) enc = inner.bytes();
          else inner.skip(k.wireType);
        }
      } else f4f3.skip(m.wireType);
    }
  } else if (n.field === 4 && n.wireType === 2) contentCt = r4.bytes();
  else r4.skip(n.wireType);
}
log(`enc (33B compressed P-256): ${Buffer.from(enc).toString("hex")}`);
log(`na (12B): ${Buffer.from(na).toString("hex")}`);
log(`secondField (16B): ${Buffer.from(secondField).toString("hex")}`);
log(`content ct (${contentCt.byteLength}B): ${Buffer.from(contentCt).toString("hex").slice(0, 64)}…`);

// Decompress enc to 65B uncompressed via SubtleCrypto.
const encUncompressed = decompressP256(enc);
log(`enc uncompressed (65B): ${Buffer.from(encUncompressed).toString("hex").slice(0, 32)}…`);

// Set up HPKE suite. KEM: DHKEM(P-256, HKDF-SHA256). KDF: HKDF-SHA256. AEAD: AES-128-GCM.
const suite = new CipherSuite({
  kem: KemId.DhkemP256HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes128Gcm,
});

// Build recipient private key in JWK.
const recipientPubJwk = await crypto.subtle.importKey(
  "jwk",
  { kty: "EC", crv: "P-256",
    x: b64u(myPub.subarray(1, 33)),
    y: b64u(myPub.subarray(33, 65)) },
  { name: "ECDH", namedCurve: "P-256" },
  true,
  [],
);
const recipientPrivJwk = await crypto.subtle.importKey(
  "jwk",
  { kty: "EC", crv: "P-256",
    x: b64u(myPub.subarray(1, 33)),
    y: b64u(myPub.subarray(33, 65)),
    d: b64u(myPriv) },
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"],
);

// Try several info / AAD candidates.
const infoCands: Array<{ name: string; b: Uint8Array | undefined }> = [
  { name: "(none)", b: undefined },
  { name: "empty", b: new Uint8Array(0) },
  { name: "FIDELIUS_SNAP_PHI", b: new TextEncoder().encode("FIDELIUS_SNAP_PHI") },
  { name: "FIDELIUS_SNAP_INVERSE_PHI", b: new TextEncoder().encode("FIDELIUS_SNAP_INVERSE_PHI") },
  { name: "fidelius", b: new TextEncoder().encode("fidelius") },
  { name: "Fidelius", b: new TextEncoder().encode("Fidelius") },
  { name: "snap_phi", b: new TextEncoder().encode("snap_phi") },
];

const aadCands: Array<{ name: string; b: Uint8Array | undefined }> = [
  { name: "(none)", b: undefined },
  { name: "empty", b: new Uint8Array(0) },
  { name: "secondField(16B)", b: secondField },
  { name: "na(12B)", b: na },
  { name: "myPkid(5B)", b: myPkid },
];

log(`\n--- HPKE-v1 base mode, KEM=DHKEM(P-256,HKDF-SHA256), KDF=HKDF-SHA256, AEAD=AES-128-GCM ---`);
let wins = 0;
for (const info of infoCands) {
  for (const aad of aadCands) {
    try {
      const ctx = await suite.createRecipientContext({
        recipientKey: recipientPrivJwk,
        enc: encUncompressed.buffer.slice(encUncompressed.byteOffset, encUncompressed.byteOffset + 65),
        info: info.b?.buffer.slice(info.b.byteOffset, info.b.byteOffset + info.b.byteLength),
      });
      const cek = await ctx.open(myCt, aad?.b?.buffer);
      const cekBytes = new Uint8Array(cek);
      log(`✅ HPKE open succeeded! info=${info.name} aad=${aad.name} → CEK (${cekBytes.byteLength}B): ${Buffer.from(cekBytes).toString("hex")}`);
      // Try to decrypt content with this CEK
      try {
        const tag = contentCt.slice(contentCt.byteLength - 16);
        const ct = contentCt.slice(0, contentCt.byteLength - 16);
        const d = createDecipheriv("aes-128-gcm", cekBytes, na);
        d.setAuthTag(tag);
        const pt = Buffer.concat([d.update(ct), d.final()]);
        log(`  ✅✅ content decrypts: ${pt.toString("hex").slice(0, 80)}`);
        log(`  utf8: ${JSON.stringify(pt.toString("utf8").slice(0, 100))}`);
      } catch (e) {
        log(`  content decrypt failed: ${(e as Error).message.slice(0, 80)}`);
      }
      wins++;
    } catch {}
  }
}
if (!wins) log(`❌ HPKE-v1 / AES-128-GCM: no info/aad combination opened the wrapped CEK`);

// Also try AEAD = AES-256-GCM (CEK would be 32B).
const suite256 = new CipherSuite({
  kem: KemId.DhkemP256HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});
log(`\n--- HPKE-v1 base mode, AEAD=AES-256-GCM ---`);
for (const info of infoCands) {
  for (const aad of aadCands) {
    try {
      const ctx = await suite256.createRecipientContext({
        recipientKey: recipientPrivJwk,
        enc: encUncompressed.buffer.slice(encUncompressed.byteOffset, encUncompressed.byteOffset + 65),
        info: info.b?.buffer.slice(info.b.byteOffset, info.b.byteOffset + info.b.byteLength),
      });
      const cek = await ctx.open(myCt, aad?.b?.buffer);
      const cekBytes = new Uint8Array(cek);
      log(`✅ HPKE open succeeded (AES-256)! info=${info.name} aad=${aad.name} → CEK (${cekBytes.byteLength}B): ${Buffer.from(cekBytes).toString("hex")}`);
      wins++;
    } catch {}
  }
}
if (!wins) log(`❌ no HPKE combination opened the wrapped CEK at all`);

function decompressP256(point: Uint8Array): Uint8Array {
  if (point.byteLength === 65 && point[0] === 0x04) return point;
  if (point.byteLength !== 33) throw new Error(`expected 33B compressed, got ${point.byteLength}`);
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
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
