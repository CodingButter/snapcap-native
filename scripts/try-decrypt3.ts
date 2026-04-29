/**
 * Maybe the wrap layout is different than {phi=16B, tag=16B}.
 * Try: 32B is ciphertext for AES-256-GCM, tag is `secondField` (16B).
 * Try: 32B is ciphertext for AES-128-CTR (no tag).
 * Try: 32B is AES-Key-Wrap output (24B input → 32B output).
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
console.log(`shared: ${shared.toString("hex")}`);
console.log(`wrapped (32B): ${Buffer.from(myCt!).toString("hex")}`);
console.log(`secondField (16B): ${Buffer.from(secondField).toString("hex")}`);
console.log(`na (12B): ${Buffer.from(na).toString("hex")}`);

const myPubC = compressP256(myPub);

console.log(`\n=== Hypothesis 1: 32B is full AES-256-GCM ciphertext, tag = secondField ===`);
let wins = 0;
const ivCands = [na, secondField.subarray(0, 12), new Uint8Array(12)];
const ivNames = ["na", "secondField[0:12]", "zero12"];
const infos = [new Uint8Array(0), te("fidelius"), te("FIDELIUS_SNAP_PHI"), te("FIDELIUS_SNAP_INVERSE_PHI"), te("snap-phi"), te("phi"), te("Fidelius"), te("snap_key")];
const salts = [new Uint8Array(0), na, secondField, enc, myPubC, Buffer.concat([myPubC, enc])];
const saltNames = ["empty", "na", "secondField", "enc", "myPubC", "myPubC+enc"];
const aads = [undefined, new Uint8Array(0), myPubC, enc, myPub, Buffer.concat([myPubC, enc]), Buffer.concat([enc, myPubC]), myPkid] as Array<Uint8Array | undefined>;
const aadNames = ["(none)", "empty", "myPubC", "enc", "myPub65", "myPubC+enc", "enc+myPubC", "myPkid"];

for (let infoI = 0; infoI < infos.length; infoI++) {
  for (let saltI = 0; saltI < salts.length; saltI++) {
    const key = Buffer.from(hkdfSync("sha256", shared, salts[saltI]!, infos[infoI]!, 32));
    for (let ivI = 0; ivI < ivCands.length; ivI++) {
      for (let aadI = 0; aadI < aads.length; aadI++) {
        try {
          // ct=32B, tag=16B (secondField)
          const d = createDecipheriv("aes-256-gcm", key, ivCands[ivI]!);
          if (aads[aadI]) d.setAAD(aads[aadI]!);
          d.setAuthTag(secondField);
          const pt = Buffer.concat([d.update(myCt!), d.final()]);
          console.log(`✅ AES-256-GCM | iv=${ivNames[ivI]} salt=${saltNames[saltI]} info(${infos[infoI]?.byteLength}B)=${Buffer.from(infos[infoI]!).toString("utf8") || "empty"} aad=${aadNames[aadI]} → ${pt.toString("hex")} (${pt.byteLength}B)`);
          wins++;
        } catch {}
      }
    }
  }
}

console.log(`\n=== Hypothesis 2: 32B is AES-128-CTR ciphertext (no tag) ===`);
for (let infoI = 0; infoI < infos.length; infoI++) {
  for (let saltI = 0; saltI < salts.length; saltI++) {
    const key = Buffer.from(hkdfSync("sha256", shared, salts[saltI]!, infos[infoI]!, 16));
    for (let ivI = 0; ivI < ivCands.length; ivI++) {
      try {
        const ivIn = ivCands[ivI]!;
        const ivPadded = ivIn.byteLength === 16 ? ivIn : Buffer.concat([Buffer.from(ivIn), Buffer.alloc(16 - ivIn.byteLength)]);
        const d = createDecipheriv("aes-128-ctr", key, ivPadded);
        const pt = Buffer.concat([d.update(myCt!), d.final()]);
        // Heuristic: print only if first byte looks like a typical CEK byte (high entropy)
        // and try to use this as a CEK to decrypt content (real check)
        // First 16B as CEK
        try {
          const cek = pt.subarray(0, 16);
          const cd = createDecipheriv("aes-128-gcm", cek, na);
          cd.setAuthTag(contentCt.slice(contentCt.byteLength - 16));
          const ptC = Buffer.concat([cd.update(contentCt.slice(0, contentCt.byteLength - 16)), cd.final()]);
          console.log(`✅ CTR-CEK[0:16] decrypted content: ${ptC.toString("utf8").slice(0, 100)}`);
          wins++;
        } catch {}
        // Last 16B as CEK
        try {
          const cek = pt.subarray(16, 32);
          const cd = createDecipheriv("aes-128-gcm", cek, na);
          cd.setAuthTag(contentCt.slice(contentCt.byteLength - 16));
          const ptC = Buffer.concat([cd.update(contentCt.slice(0, contentCt.byteLength - 16)), cd.final()]);
          console.log(`✅ CTR-CEK[16:32] decrypted content: ${ptC.toString("utf8").slice(0, 100)}`);
          wins++;
        } catch {}
      } catch {}
    }
  }
}

console.log(`\n=== Hypothesis 3: 32B is XOR with derived key, NO authentication ===`);
for (let infoI = 0; infoI < infos.length; infoI++) {
  for (let saltI = 0; saltI < salts.length; saltI++) {
    try {
      const key = Buffer.from(hkdfSync("sha256", shared, salts[saltI]!, infos[infoI]!, 32));
      const xored = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) xored[i] = myCt![i]! ^ key[i]!;
      // Try CEK = xored[0:16] or [0:32]
      try {
        const cek = xored.subarray(0, 16);
        const cd = createDecipheriv("aes-128-gcm", cek, na);
        cd.setAuthTag(contentCt.slice(contentCt.byteLength - 16));
        const ptC = Buffer.concat([cd.update(contentCt.slice(0, contentCt.byteLength - 16)), cd.final()]);
        console.log(`✅ XOR-CEK[0:16] | salt=${saltNames[saltI]} info=${Buffer.from(infos[infoI]!).toString("utf8") || "empty"} → ${ptC.toString("utf8").slice(0, 100)}`);
        wins++;
      } catch {}
    } catch {}
  }
}

console.log(`\nfinal wins = ${wins}`);

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
