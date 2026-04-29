/**
 * Try ChaCha20-Poly1305 decryption with various KDFs.
 */
import { CipherSuite, KemId, KdfId, AeadId } from "hpke-js";
import { createDecipheriv, createPublicKey, createHash, hkdfSync, diffieHellman, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius;
if (!fid) throw new Error("no fidelius");
const myPriv = hexToBytes(fid.privateKey);
const myPub = hexToBytes(fid.publicKey);
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);

const data = readFileSync("/tmp/inbox_8fee42df.bin");
const top = new ProtoReader(new Uint8Array(data));
let f1: Uint8Array | null = null;
for (let n = top.next(); n; n = top.next()) {
  if (n.field === 1 && n.wireType === 2) f1 = top.bytes(); else top.skip(n.wireType);
}
if (!f1) throw new Error();
let f3: Uint8Array | null = null, f4: Uint8Array | null = null;
const r1 = new ProtoReader(f1);
for (let n = r1.next(); n; n = r1.next()) {
  if (n.field === 3 && n.wireType === 2) f3 = r1.bytes();
  else if (n.field === 4 && n.wireType === 2) f4 = r1.bytes();
  else r1.skip(n.wireType);
}
if (!f3 || !f4) throw new Error();
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
if (!myCt) throw new Error();
let enc = new Uint8Array(0), na = new Uint8Array(0), secondField = new Uint8Array(0);
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
  } else r4.skip(n.wireType);
}

// ECDH manually
const myPrivKey = createPrivateKey({
  key: { kty: "EC", crv: "P-256",
    x: b64u(myPub.subarray(1, 33)), y: b64u(myPub.subarray(33, 65)), d: b64u(myPriv) },
  format: "jwk",
});
const senderPubU = decompressP256(enc);
const senderPubKey = createPublicKey({
  key: { kty: "EC", crv: "P-256",
    x: b64u(senderPubU.subarray(1, 33)), y: b64u(senderPubU.subarray(33, 65)) },
  format: "jwk",
});
const shared = diffieHellman({ privateKey: myPrivKey, publicKey: senderPubKey });
console.log(`ECDH shared (32B): ${shared.toString("hex")}`);
console.log(`wrapped (32B):     ${Buffer.from(myCt).toString("hex")}`);

// Massive brute force across cipher / KDF / IV / AAD axes.
const phi = myCt.subarray(0, 16);
const tag = myCt.subarray(16, 32);

console.log(`\n=== ChaCha20-Poly1305 attempts ===`);
let wins = 0;
const infoStrs = ["", "fidelius", "Fidelius", "FIDELIUS_SNAP_PHI", "FIDELIUS_SNAP_INVERSE_PHI",
                  "snap_key", "snap_iv", "fidelius_phi", "phi", "key", "wrap_key", "shared key", "snap"];
const salts = [
  { n: "empty", b: new Uint8Array(0) },
  { n: "na", b: na },
  { n: "secondField", b: secondField },
  { n: "myPkid", b: myPkid },
  { n: "enc", b: enc },
  { n: "na+secondField", b: Buffer.concat([na, secondField]) },
];
const ivs = [
  { n: "na", b: na },
  { n: "secondField[0:12]", b: secondField.subarray(0, 12) },
  { n: "zero12", b: new Uint8Array(12) },
  { n: "myPkid+7B", b: Buffer.concat([myPkid, new Uint8Array(7)]) },
];
const aads = [
  { n: "(none)", b: undefined as Uint8Array | undefined },
  { n: "empty", b: new Uint8Array(0) as Uint8Array | undefined },
  { n: "secondField", b: secondField as Uint8Array | undefined },
  { n: "na", b: na as Uint8Array | undefined },
  { n: "myPkid", b: myPkid as Uint8Array | undefined },
  { n: "enc", b: enc as Uint8Array | undefined },
  { n: "encU", b: senderPubU as Uint8Array | undefined },
];
let cnt = 0;
for (const info of infoStrs) {
  for (const salt of salts) {
    for (const iv of ivs) {
      for (const aad of aads) {
        cnt++;
        try {
          const key = Buffer.from(hkdfSync("sha256", shared, salt.b, new TextEncoder().encode(info), 32));
          const d = createDecipheriv("chacha20-poly1305", key, iv.b, { authTagLength: 16 });
          if (aad.b) d.setAAD(aad.b);
          d.setAuthTag(tag);
          const cek = Buffer.concat([d.update(phi), d.final()]);
          console.log(`✅ ChaCha-Poly | info="${info}" salt=${salt.n} iv=${iv.n} aad=${aad.n} → ${cek.toString("hex")}`);
          wins++;
        } catch {}
      }
    }
  }
}
console.log(`tried ${cnt} ChaCha combos. wins=${wins}`);

// Also try plain AES-128-GCM with shared as direct key (no HKDF)
console.log(`\n=== AES-128-GCM with direct ECDH-derived keys ===`);
const directKeys = [
  { n: "shared[0:16]", k: shared.subarray(0, 16) },
  { n: "shared[16:32]", k: shared.subarray(16, 32) },
  { n: "sha256(shared)[0:16]", k: createHash("sha256").update(shared).digest().subarray(0, 16) },
  { n: "sha256(shared+enc)[0:16]", k: createHash("sha256").update(Buffer.concat([shared, enc])).digest().subarray(0, 16) },
  { n: "sha256(shared+myPub)[0:16]", k: createHash("sha256").update(Buffer.concat([shared, myPub])).digest().subarray(0, 16) },
  { n: "sha256(shared+enc+myPub)[0:16]", k: createHash("sha256").update(Buffer.concat([shared, enc, myPub])).digest().subarray(0, 16) },
  { n: "sha256(enc+shared+myPub)[0:16]", k: createHash("sha256").update(Buffer.concat([enc, shared, myPub])).digest().subarray(0, 16) },
];
for (const k of directKeys) {
  for (const iv of ivs) {
    for (const aad of aads) {
      try {
        const d = createDecipheriv("aes-128-gcm", k.k, iv.b);
        if (aad.b) d.setAAD(aad.b);
        d.setAuthTag(tag);
        const cek = Buffer.concat([d.update(phi), d.final()]);
        console.log(`✅ AES128GCM | key=${k.n} iv=${iv.n} aad=${aad.n} → ${cek.toString("hex")}`);
        wins++;
      } catch {}
    }
  }
}
console.log(`total wins: ${wins}`);

function decompressP256(point: Uint8Array): Uint8Array {
  if (point.byteLength === 65) return point;
  const spki = Buffer.concat([
    Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
    Buffer.from(point),
  ]);
  const k = createPublicKey({ key: spki, format: "der", type: "spki" });
  const jwk = k.export({ format: "jwk" }) as { x: string; y: string };
  return new Uint8Array([0x04,
    ...Buffer.from(jwk.x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.x.length / 4) * 4, "="), "base64"),
    ...Buffer.from(jwk.y.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.y.length / 4) * 4, "="), "base64")]);
}
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
