import { createDecipheriv, createPublicKey, createPrivateKey, createHash, hkdfSync, diffieHellman } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "./src/index.ts";
import { ProtoReader } from "./src/transport/proto-encode.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius!;
const myPriv = Buffer.from(fid.privateKey, "hex");
const myPub = Buffer.from(fid.publicKey, "hex");
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);

// pkid=173206fbd5, na=7bdda388bd29f5d8d6aad4e4, secondField=8c25d652dbf283666cce85f1abfdc0d2
// enc=03483d3b...
const phi = Buffer.from("e542ea2cb4bfc6945a96e9ff361afb9f", "hex");
const tag = Buffer.from("097febd3f53fe451ac3c8cb3f7c32c47", "hex");
const enc = Buffer.from("03483d3ba2ac303985ce06f3e42f76d3ac5a17696d02fe2160436ea62f81e114d1", "hex");
const na = Buffer.from("7bdda388bd29f5d8d6aad4e4", "hex");
const secondField = Buffer.from("8c25d652dbf283666cce85f1abfdc0d2", "hex");

// Decompress sender pub
const spki = Buffer.concat([Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"), enc]);
const k = createPublicKey({ key: spki, format: "der", type: "spki" });
const jwk = k.export({ format: "jwk" }) as { x: string; y: string };
const senderPubU = Buffer.concat([Buffer.from([4]),
  Buffer.from(jwk.x.replace(/-/g,"+").replace(/_/g,"/"), "base64"),
  Buffer.from(jwk.y.replace(/-/g,"+").replace(/_/g,"/"), "base64")]);

const myPrivKey = createPrivateKey({
  key: { kty: "EC", crv: "P-256",
    x: Buffer.from(myPub.subarray(1, 33)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    y: Buffer.from(myPub.subarray(33, 65)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    d: Buffer.from(myPriv).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"") },
  format: "jwk",
});
const senderPubKey = createPublicKey({
  key: { kty: "EC", crv: "P-256",
    x: Buffer.from(senderPubU.subarray(1, 33)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    y: Buffer.from(senderPubU.subarray(33, 65)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"") },
  format: "jwk",
});
const shared = diffieHellman({ privateKey: myPrivKey, publicKey: senderPubKey });

// myPubC for AAD candidates
const myYLast = myPub[64]!;
const myPubC = Buffer.concat([Buffer.from([(myYLast & 1) ? 0x03 : 0x02]), myPub.subarray(1, 33)]);

// AAD candidates: try proto-serialized recipient info without phi/macTag, plus other identifying bytes
const aadCands: Array<{ n: string; b: Uint8Array }> = [
  // proto serialized {f1: pkid(5B), f2: 10}
  { n: "proto(pkid,version)", b: Buffer.concat([Buffer.from([0x0a, 5]), myPkid, Buffer.from([0x10, 10])]) },
  // larger: include sender pubkey too
  { n: "proto(pkid,version,sender)", b: Buffer.concat([Buffer.from([0x0a, 5]), myPkid, Buffer.from([0x10, 10]), Buffer.from([0x1a, 33]), enc]) },
  // recipient public key (compressed) + version  
  { n: "myPubC+version", b: Buffer.concat([myPubC, Buffer.from([10])]) },
  // sender + recipient compressed
  { n: "enc+myPubC", b: Buffer.concat([enc, myPubC]) },
  { n: "enc+myPubC+secondField", b: Buffer.concat([enc, myPubC, secondField]) },
  { n: "secondField+enc+myPubC", b: Buffer.concat([secondField, enc, myPubC]) },
  // Just pkid
  { n: "pkid", b: myPkid },
  // pkid+version
  { n: "pkid+v10", b: Buffer.concat([myPkid, Buffer.from([10])]) },
  // sender pkid (computed from senderPubU)
  { n: "senderPkid", b: createHash("sha256").update(senderPubU).digest().subarray(0, 5) },
];

const keyCands: Array<{ n: string; k: Uint8Array }> = [];
const ikms = [shared, Buffer.concat([shared, myPubC]), Buffer.concat([myPubC, shared]), Buffer.concat([shared, enc]), Buffer.concat([enc, shared]), Buffer.concat([shared, myPubC, enc])];
const ikmNames = ["shared", "shared|myPubC", "myPubC|shared", "shared|enc", "enc|shared", "shared|myPubC|enc"];
const salts = [new Uint8Array(0), na, secondField, Buffer.concat([na, secondField])];
const saltNames = ["empty", "na", "secondField", "na|secondField"];
const infos = ["", "fidelius", "Fidelius", "snap_phi", "phi", "FIDELIUS_SNAP_PHI", "FIDELIUS_SNAP_INVERSE_PHI", "FideliusEncryption"];
for (let i = 0; i < ikms.length; i++) {
  for (let j = 0; j < salts.length; j++) {
    for (const inf of infos) {
      try {
        const k = Buffer.from(hkdfSync("sha256", ikms[i]!, salts[j]!, new TextEncoder().encode(inf), 16));
        keyCands.push({ n: `hkdf(${ikmNames[i]},${saltNames[j]},${inf || "empty"})`, k });
      } catch {}
    }
  }
}
const ivCands = [
  { n: "na", iv: na },
  { n: "secondField[0:12]", iv: secondField.subarray(0, 12) },
  { n: "zero12", iv: new Uint8Array(12) },
];
let wins = 0;
let cnt = 0;
for (const k of keyCands) {
  for (const iv of ivCands) {
    for (const aad of aadCands) {
      cnt++;
      try {
        const d = createDecipheriv("aes-128-gcm", k.k, iv.iv);
        d.setAAD(aad.b);
        d.setAuthTag(tag);
        const cek = Buffer.concat([d.update(phi), d.final()]);
        console.log(`✅ key=${k.n} iv=${iv.n} aad=${aad.n}(${aad.b.length}B) → ${cek.toString("hex")}`);
        wins++;
      } catch {}
    }
  }
}
console.log(`tried ${cnt}. wins=${wins}`);
