/**
 * One more angle: try IV/key derivation variations specifically tied
 * to recipient identity. In Signal-like protocols the wrap binds to
 * the specific recipient, so iv or key may include a hash of the
 * recipient pubkey or pkid.
 */
import { createDecipheriv, createPublicKey, createPrivateKey, createHash, createHmac, hkdfSync, diffieHellman } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius!;
const myPriv = hexToBytes(fid.privateKey);
const myPub = hexToBytes(fid.publicKey);
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);

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
let enc = new Uint8Array(0), na = new Uint8Array(0), secondField = new Uint8Array(0), contentCt = new Uint8Array(0);
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
  } else if (n.field === 4 && n.wireType === 2) contentCt = r4.bytes();
  else r4.skip(n.wireType);
}

const senderPubU = decompressP256(enc);
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
const myPubC = compressP256(myPub);
const phi = myCt!.subarray(0, 16);
const tag = myCt!.subarray(16, 32);

console.log(`Trying recipient-bound IV/key derivations...`);
let wins = 0;

// Generate many candidate wrap keys
const allKeys: Array<{ n: string; k: Uint8Array }> = [];
const allIvs: Array<{ n: string; iv: Uint8Array }> = [];

// Keys: from various combinations
const ikms = [
  { n: "shared", b: shared },
  { n: "shared+myPubC", b: Buffer.concat([shared, myPubC]) },
  { n: "shared+myPub", b: Buffer.concat([shared, myPub]) },
  { n: "myPubC+shared", b: Buffer.concat([myPubC, shared]) },
  { n: "shared+enc", b: Buffer.concat([shared, enc]) },
  { n: "shared+enc+myPubC", b: Buffer.concat([shared, enc, myPubC]) },
  { n: "enc+shared+myPubC", b: Buffer.concat([enc, shared, myPubC]) },
  { n: "myPubC+enc+shared", b: Buffer.concat([myPubC, enc, shared]) },
  { n: "shared+myPkid", b: Buffer.concat([shared, myPkid]) },
];
const salts = [
  { n: "empty", b: new Uint8Array(0) },
  { n: "secondField", b: secondField },
  { n: "na", b: na },
  { n: "enc", b: enc },
  { n: "myPubC", b: myPubC },
  { n: "secondField+enc", b: Buffer.concat([secondField, enc]) },
];
const infos = [
  { n: "empty", b: new Uint8Array(0) },
  { n: "fidelius", b: te("fidelius") },
  { n: "Fidelius", b: te("Fidelius") },
  { n: "phi", b: te("phi") },
  { n: "key", b: te("key") },
  { n: "wrap", b: te("wrap") },
  { n: "snap", b: te("snap") },
  { n: "snap-phi", b: te("snap-phi") },
];

for (const ikm of ikms) {
  for (const salt of salts) {
    for (const info of infos) {
      try {
        const k = Buffer.from(hkdfSync("sha256", ikm.b, salt.b, info.b, 16));
        allKeys.push({ n: `hkdf(${ikm.n},${salt.n},${info.n})`, k });
      } catch {}
    }
  }
}

// IV variants tied to recipient
allIvs.push({ n: "na", iv: na });
allIvs.push({ n: "secondField[0:12]", iv: secondField.subarray(0, 12) });
allIvs.push({ n: "zero12", iv: new Uint8Array(12) });
allIvs.push({ n: "myPkid+7B", iv: Buffer.concat([myPkid, new Uint8Array(7)]) });
allIvs.push({ n: "hmac(shared,myPubC)[0:12]", iv: createHmac("sha256", shared).update(myPubC).digest().subarray(0, 12) });
allIvs.push({ n: "hmac(shared,enc)[0:12]", iv: createHmac("sha256", shared).update(enc).digest().subarray(0, 12) });
allIvs.push({ n: "sha256(shared+myPubC)[0:12]", iv: createHash("sha256").update(Buffer.concat([shared, myPubC])).digest().subarray(0, 12) });
allIvs.push({ n: "sha256(secondField+myPubC)[0:12]", iv: createHash("sha256").update(Buffer.concat([secondField, myPubC])).digest().subarray(0, 12) });
allIvs.push({ n: "sha256(na+myPubC)[0:12]", iv: createHash("sha256").update(Buffer.concat([na, myPubC])).digest().subarray(0, 12) });
allIvs.push({ n: "secondField[4:16]", iv: secondField.subarray(4, 16) });

// Tagged AADs including recipient-binding
const aads: Array<{ n: string; b?: Uint8Array }> = [
  { n: "(none)" },
  { n: "myPubC", b: myPubC },
  { n: "enc+myPubC", b: Buffer.concat([enc, myPubC]) },
  { n: "myPubC+enc", b: Buffer.concat([myPubC, enc]) },
  { n: "myPub65", b: myPub },
];

let cnt = 0;
for (const k of allKeys) {
  for (const iv of allIvs) {
    for (const aad of aads) {
      cnt++;
      try {
        const d = createDecipheriv("aes-128-gcm", k.k, iv.iv);
        if (aad.b) d.setAAD(aad.b);
        d.setAuthTag(tag);
        const cek = Buffer.concat([d.update(phi), d.final()]);
        console.log(`✅ key=${k.n} iv=${iv.n} aad=${aad.n} → CEK ${cek.toString("hex")}`);
        wins++;
      } catch {}
    }
  }
}
console.log(`${cnt} combos. wins=${wins}`);

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
