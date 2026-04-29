/**
 * Try HPKE export-only mode + custom AES-GCM. Maybe Snap uses HPKE
 * KEM+KDF to derive a wrap key but applies AES-GCM separately (with
 * Snap's own IV/AAD choices).
 */
import { CipherSuite, KemId, KdfId, AeadId } from "hpke-js";
import { createDecipheriv, createPublicKey, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

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
if (!myCt) throw new Error("no recipient entry");

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
const encU = decompressP256(enc);

const recipientPriv = await crypto.subtle.importKey("jwk",
  { kty: "EC", crv: "P-256",
    x: b64u(myPub.subarray(1, 33)),
    y: b64u(myPub.subarray(33, 65)),
    d: b64u(myPriv) },
  { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);

// Try HPKE export-only mode. AeadId.ExportOnly = 0xFFFF.
const suite = new CipherSuite({
  kem: KemId.DhkemP256HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.ExportOnly,
});

const phi = myCt.subarray(0, 16);
const tag = myCt.subarray(16, 32);

const infoCands: Array<{ name: string; b: Uint8Array }> = [
  { name: "empty", b: new Uint8Array(0) },
  { name: "fidelius", b: te("fidelius") },
  { name: "Fidelius", b: te("Fidelius") },
  { name: "FIDELIUS_SNAP_PHI", b: te("FIDELIUS_SNAP_PHI") },
  { name: "FIDELIUS_SNAP_INVERSE_PHI", b: te("FIDELIUS_SNAP_INVERSE_PHI") },
  { name: "fidelius_snap", b: te("fidelius_snap") },
  { name: "snap_phi", b: te("snap_phi") },
  { name: "snap_iv", b: te("snap_iv") },
  { name: "snap_key", b: te("snap_key") },
  { name: "Phi", b: te("Phi") },
  { name: "InversePhi", b: te("InversePhi") },
  { name: "snapchat", b: te("snapchat") },
  { name: "snapchat_messaging", b: te("snapchat_messaging") },
  { name: "snapchat.messaging", b: te("snapchat.messaging") },
  { name: "snapchat.fidelius", b: te("snapchat.fidelius") },
  { name: "messaging", b: te("messaging") },
  { name: "key_wrap", b: te("key_wrap") },
];

const exportLabels = ["snap_key", "snap_iv", "key", "iv", "wrap_key", "wrap_iv", "fidelius_key", "fidelius_iv"];

const aads: Array<{ name: string; b: Uint8Array | undefined }> = [
  { name: "(none)", b: undefined },
  { name: "secondField", b: secondField },
  { name: "na", b: na },
  { name: "myPkid", b: myPkid },
  { name: "enc(33B)", b: enc },
];

log(`testing HPKE export-only with ${infoCands.length} info × ${exportLabels.length}² export labels × ${aads.length} aads…`);
let wins = 0;
for (const info of infoCands) {
  let ctx;
  try {
    ctx = await suite.createRecipientContext({
      recipientKey: recipientPriv,
      enc: encU.buffer.slice(encU.byteOffset, encU.byteOffset + 65),
      info: info.b.buffer.slice(info.b.byteOffset, info.b.byteOffset + info.b.byteLength),
    });
  } catch (e) {
    log(`  info=${info.name}: createRecipientContext threw: ${(e as Error).message.slice(0, 60)}`);
    continue;
  }
  for (const keyLabel of exportLabels) {
    let key16: ArrayBuffer;
    try {
      key16 = await ctx.export(te(keyLabel).buffer.slice(0), 16);
    } catch { continue; }
    for (const ivLabel of exportLabels) {
      let iv12: ArrayBuffer;
      try {
        iv12 = await ctx.export(te(ivLabel).buffer.slice(0), 12);
      } catch { continue; }
      for (const aad of aads) {
        try {
          const d = createDecipheriv("aes-128-gcm", new Uint8Array(key16), new Uint8Array(iv12));
          if (aad.b) d.setAAD(aad.b);
          d.setAuthTag(tag);
          const cek = Buffer.concat([d.update(phi), d.final()]);
          log(`✅ HPKE-export | info=${info.name} keyLbl=${keyLabel} ivLbl=${ivLabel} aad=${aad.name} → CEK ${cek.toString("hex")}`);
          wins++;
          // Try content decrypt
          try {
            const cd = createDecipheriv("aes-128-gcm", cek, na);
            cd.setAuthTag(contentCt.slice(contentCt.byteLength - 16));
            const pt = Buffer.concat([cd.update(contentCt.slice(0, contentCt.byteLength - 16)), cd.final()]);
            log(`   ✅✅ content: ${JSON.stringify(pt.toString("utf8").slice(0, 100))}`);
          } catch (e) {
            log(`   content decrypt failed: ${(e as Error).message.slice(0, 60)}`);
          }
        } catch {}
      }
      // Also try with na as IV (instead of exported one)
      for (const aad of aads) {
        try {
          const d = createDecipheriv("aes-128-gcm", new Uint8Array(key16), na);
          if (aad.b) d.setAAD(aad.b);
          d.setAuthTag(tag);
          const cek = Buffer.concat([d.update(phi), d.final()]);
          log(`✅ HPKE-export-key + IV=na | info=${info.name} keyLbl=${keyLabel} aad=${aad.name} → CEK ${cek.toString("hex")}`);
          wins++;
        } catch {}
      }
    }
  }
}
if (!wins) log(`❌ HPKE export-only didn't find a working combo`);

function te(s: string) { return new TextEncoder().encode(s); }
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
