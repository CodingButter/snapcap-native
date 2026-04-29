/**
 * Sender pubkey IS Jamie's identity. ECDH IS correct. But brute force
 * over (KDF info × salt × IV × AAD) hasn't decrypted. Try variations
 * that include identity material in AAD or KDF info.
 */
import { createDecipheriv, createPublicKey, createPrivateKey, createHash, hkdfSync, diffieHellman } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius!;
const myPriv = hexToBytes(fid.privateKey);
const myPub = hexToBytes(fid.publicKey);
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);
console.log(`me pubkey: ${Buffer.from(myPub).toString("hex")}`);
console.log(`me pkid:   ${Buffer.from(myPkid).toString("hex")}`);

// Parse capture
const data = readFileSync("/tmp/inbox_8fee42df.bin");
const top = new ProtoReader(new Uint8Array(data));
let f1: Uint8Array | null = null;
for (let n = top.next(); n; n = top.next()) {
  if (n.field === 1 && n.wireType === 2) f1 = top.bytes(); else top.skip(n.wireType);
}
let f3: Uint8Array | null = null, f4: Uint8Array | null = null;
const r1 = new ProtoReader(f1!);
for (let n = r1.next(); n; n = r1.next()) {
  if (n.field === 3 && n.wireType === 2) f3 = r1.bytes();
  else if (n.field === 4 && n.wireType === 2) f4 = r1.bytes();
  else r1.skip(n.wireType);
}
let myCt: Uint8Array | null = null;
const r3 = new ProtoReader(f3!);
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
            for (let ff = e.next(); ff; ff = e.next()) {
              if (ff.field === 1 && ff.wireType === 2) pkid = e.bytes();
              else if (ff.field === 3 && ff.wireType === 2) wrapped = e.bytes();
              else e.skip(ff.wireType);
            }
            if (Buffer.from(pkid).equals(Buffer.from(myPkid))) myCt = new Uint8Array(wrapped);
          } else f99f5.skip(k.wireType);
        }
      } else f99.skip(m.wireType);
    }
  } else r3.skip(n.wireType);
}
let enc = new Uint8Array(0), na = new Uint8Array(0), secondField = new Uint8Array(0);
const r4 = new ProtoReader(f4!);
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
  } else r4.skip(n.wireType);
}

const senderPubU = decompressP256(enc);
console.log(`sender (Jamie) identity pub: ${Buffer.from(senderPubU).toString("hex")}`);

const myPrivKey = createPrivateKey({
  key: { kty: "EC", crv: "P-256",
    x: b64u(myPub.subarray(1, 33)), y: b64u(myPub.subarray(33, 65)), d: b64u(myPriv) },
  format: "jwk",
});
const senderPubKey = createPublicKey({
  key: { kty: "EC", crv: "P-256",
    x: b64u(senderPubU.subarray(1, 33)), y: b64u(senderPubU.subarray(33, 65)) },
  format: "jwk",
});
const shared = diffieHellman({ privateKey: myPrivKey, publicKey: senderPubKey });
console.log(`shared secret: ${shared.toString("hex")}`);

const phi = myCt!.subarray(0, 16);
const tag = myCt!.subarray(16, 32);
const senderPubC = enc;  // 33B compressed
const myPubC = compressP256(myPub);  // 33B compressed
console.log(`my pubkey compressed: ${Buffer.from(myPubC).toString("hex")}`);

// Now exhaustive variations focused on identity-binding
const infoMaterial = [
  { n: "empty", b: new Uint8Array(0) },
  { n: "fidelius", b: te("fidelius") },
  { n: "Fidelius", b: te("Fidelius") },
  { n: "snap-phi", b: te("snap-phi") },
  { n: "phi", b: te("phi") },
  { n: "key", b: te("key") },
  { n: "wrap", b: te("wrap") },
  { n: "FideliusEncryption", b: te("FideliusEncryption") },
  { n: "Fidelius-v1", b: te("Fidelius-v1") },
  { n: "FideliusEncryptionStrategy", b: te("FideliusEncryptionStrategy") },
  { n: "snapchat.fidelius", b: te("snapchat.fidelius") },
  { n: "snapchat.messaging.FideliusEncryption", b: te("snapchat.messaging.FideliusEncryption") },
];
const saltMaterial = [
  { n: "empty", b: new Uint8Array(0) },
  { n: "secondField", b: secondField },
  { n: "na", b: na },
  { n: "enc", b: enc },
  { n: "myPubC", b: myPubC },
  { n: "myPub65", b: myPub },
  { n: "secondField+na", b: Buffer.concat([secondField, na]) },
  { n: "myPubC+enc", b: Buffer.concat([myPubC, enc]) },
];
const ivMaterial = [
  { n: "na", b: na },
  { n: "secondField[0:12]", b: secondField.subarray(0, 12) },
  { n: "zero12", b: new Uint8Array(12) },
  { n: "myPkid+7", b: Buffer.concat([myPkid, new Uint8Array(7)]) },
  { n: "secondField[4:16]", b: secondField.subarray(4, 16) },
];
const aadMaterial = [
  { n: "(none)", b: undefined as Uint8Array | undefined },
  { n: "empty", b: new Uint8Array(0) as Uint8Array | undefined },
  { n: "myPub", b: myPub as Uint8Array | undefined },
  { n: "myPubC", b: myPubC as Uint8Array | undefined },
  { n: "senderPub", b: senderPubU as Uint8Array | undefined },
  { n: "senderPubC", b: senderPubC as Uint8Array | undefined },
  { n: "myPubC+senderPubC", b: Buffer.concat([myPubC, senderPubC]) as Uint8Array | undefined },
  { n: "senderPubC+myPubC", b: Buffer.concat([senderPubC, myPubC]) as Uint8Array | undefined },
  { n: "myPub+senderPub", b: Buffer.concat([myPub, senderPubU]) as Uint8Array | undefined },
  { n: "myPkid", b: myPkid as Uint8Array | undefined },
  { n: "secondField", b: secondField as Uint8Array | undefined },
  { n: "na", b: na as Uint8Array | undefined },
];

console.log(`\n=== AES-128-GCM with HKDF, identity-bound AAD ===`);
let cnt = 0, wins = 0;
for (const info of infoMaterial) {
  for (const salt of saltMaterial) {
    const key = Buffer.from(hkdfSync("sha256", shared, salt.b, info.b, 16));
    for (const iv of ivMaterial) {
      for (const aad of aadMaterial) {
        cnt++;
        try {
          const d = createDecipheriv("aes-128-gcm", key, iv.b);
          if (aad.b) d.setAAD(aad.b);
          d.setAuthTag(tag);
          const cek = Buffer.concat([d.update(phi), d.final()]);
          console.log(`✅ info=${info.n} salt=${salt.n} iv=${iv.n} aad=${aad.n} → CEK ${cek.toString("hex")}`);
          wins++;
        } catch {}
      }
    }
  }
}
console.log(`tried ${cnt} combos. wins=${wins}`);

// Also try: ECDH X-only NOT used directly. Use HKDF-Extract(salt, IKM=DH || pkE || pkR) per HPKE.
const eaeIkm = Buffer.concat([shared, enc, myPubC]);  // shared || enc || pkR
const eaePrk = createHash("sha256").update(eaeIkm).digest();  // pseudo-extract
console.log(`\n=== Try with HPKE-style eae_prk = SHA256(shared||enc||myPubC) ===`);
for (const info of infoMaterial) {
  const wrapKey = Buffer.from(hkdfSync("sha256", eaePrk, new Uint8Array(0), info.b, 16));
  for (const iv of ivMaterial) {
    for (const aad of aadMaterial) {
      try {
        const d = createDecipheriv("aes-128-gcm", wrapKey, iv.b);
        if (aad.b) d.setAAD(aad.b);
        d.setAuthTag(tag);
        const cek = Buffer.concat([d.update(phi), d.final()]);
        console.log(`✅ eae_prk path | info=${info.n} iv=${iv.n} aad=${aad.n} → CEK ${cek.toString("hex")}`);
        wins++;
      } catch {}
    }
  }
}
console.log(`final wins=${wins}`);

function te(s: string) { return new TextEncoder().encode(s); }
function decompressP256(point: Uint8Array): Uint8Array {
  if (point.byteLength === 65) return point;
  const spki = Buffer.concat([Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"), Buffer.from(point)]);
  const k = createPublicKey({ key: spki, format: "der", type: "spki" });
  const jwk = k.export({ format: "jwk" }) as { x: string; y: string };
  return new Uint8Array([0x04,
    ...Buffer.from(jwk.x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.x.length / 4) * 4, "="), "base64"),
    ...Buffer.from(jwk.y.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.y.length / 4) * 4, "="), "base64")]);
}
function compressP256(uncompressed: Uint8Array): Uint8Array {
  const x = uncompressed.subarray(1, 33), y = uncompressed.subarray(33, 65);
  const out = new Uint8Array(33);
  out[0] = (y[y.byteLength - 1]! & 1) ? 0x03 : 0x02;
  out.set(x, 1);
  return out;
}
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
