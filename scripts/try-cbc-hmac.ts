/**
 * Try Encrypt-then-MAC: AES-128-CBC ciphertext + HMAC-SHA256 tag.
 * Layout: 32B = ciphertext(16B) + tag(16B).
 */
import { createDecipheriv, createPublicKey, createPrivateKey, createHash, createHmac, hkdfSync, diffieHellman, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius!;
const myPriv = Buffer.from(fid.privateKey, "hex");
const myPub = Buffer.from(fid.publicKey, "hex");
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);

const phi = Buffer.from("e542ea2cb4bfc6945a96e9ff361afb9f", "hex");
const macTag = Buffer.from("097febd3f53fe451ac3c8cb3f7c32c47", "hex");
const enc = Buffer.from("03483d3ba2ac303985ce06f3e42f76d3ac5a17696d02fe2160436ea62f81e114d1", "hex");
const na = Buffer.from("7bdda388bd29f5d8d6aad4e4", "hex");
const secondField = Buffer.from("8c25d652dbf283666cce85f1abfdc0d2", "hex");
const myPubC = Buffer.concat([Buffer.from([(myPub[64]! & 1) ? 0x03 : 0x02]), myPub.subarray(1, 33)]);

const spki = Buffer.concat([Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"), enc]);
const senderPubKey = createPublicKey({ key: spki, format: "der", type: "spki" });
const senderJwk = senderPubKey.export({ format: "jwk" }) as { x: string; y: string };
const senderPubU = Buffer.concat([Buffer.from([4]),
  Buffer.from(senderJwk.x.replace(/-/g,"+").replace(/_/g,"/"), "base64"),
  Buffer.from(senderJwk.y.replace(/-/g,"+").replace(/_/g,"/"), "base64")]);
const senderUKey = createPublicKey({ key: { kty: "EC", crv: "P-256",
  x: senderJwk.x, y: senderJwk.y }, format: "jwk" });
const myPrivKey = createPrivateKey({
  key: { kty: "EC", crv: "P-256",
    x: Buffer.from(myPub.subarray(1, 33)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    y: Buffer.from(myPub.subarray(33, 65)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    d: Buffer.from(myPriv).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"") },
  format: "jwk",
});
const shared = diffieHellman({ privateKey: myPrivKey, publicKey: senderUKey });

console.log(`shared: ${shared.toString("hex")}`);
console.log(`phi: ${phi.toString("hex")}, macTag: ${macTag.toString("hex")}`);

// CBC with IV from various sources, key from various HKDF
let wins = 0;
let cnt = 0;
const ivCands = [
  { n: "na+pad", iv: Buffer.concat([na, Buffer.alloc(4)]) },
  { n: "secondField", iv: secondField },
  { n: "secondField[0:16]", iv: secondField },
  { n: "zero16", iv: Buffer.alloc(16) },
  { n: "myPubC[0:16]", iv: myPubC.subarray(0, 16) },
];
const infoStrs = ["", "fidelius", "Fidelius", "snap_phi", "phi", "FIDELIUS_SNAP_PHI"];
const salts = [new Uint8Array(0), na, secondField];
const saltN = ["empty", "na", "secondField"];

for (let saltI = 0; saltI < salts.length; saltI++) {
  for (const info of infoStrs) {
    // Derive 32B → 16B AES key + 16B HMAC key
    const km = Buffer.from(hkdfSync("sha256", shared, salts[saltI]!, new TextEncoder().encode(info), 32));
    const aesKey = km.subarray(0, 16);
    const macKey = km.subarray(16, 32);
    for (const iv of ivCands) {
      cnt++;
      // Verify HMAC first
      // Try HMAC of (ciphertext) and (iv|ciphertext) and (ciphertext|iv)
      for (const macInputN of ["phi", "iv|phi", "phi|iv", "myPubC|phi"]) {
        let macInput: Buffer;
        if (macInputN === "phi") macInput = phi;
        else if (macInputN === "iv|phi") macInput = Buffer.concat([iv.iv, phi]);
        else if (macInputN === "phi|iv") macInput = Buffer.concat([phi, iv.iv]);
        else macInput = Buffer.concat([myPubC, phi]);
        const computedTag = createHmac("sha256", macKey).update(macInput).digest().subarray(0, 16);
        if (timingSafeEqual(computedTag, macTag)) {
          // Tag matches! Now decrypt CBC
          try {
            const d = createDecipheriv("aes-128-cbc", aesKey, iv.iv);
            d.setAutoPadding(false);
            const cek = Buffer.concat([d.update(phi), d.final()]);
            console.log(`✅ CBC+HMAC | salt=${saltN[saltI]} info=${info || "empty"} iv=${iv.n} macInput=${macInputN} → CEK ${cek.toString("hex")}`);
            wins++;
          } catch {}
        }
      }
    }
  }
}
console.log(`tried ${cnt}. wins=${wins}`);

// Also try: maybe it's AES-128-GCM with a 16B IV (non-standard but supported by BoringSSL via EVP_aead_aes_128_gcm_siv)
// Or maybe AES-CCM
console.log(`\n=== AES-128-CCM with 12B nonce ===`);
let ccmWins = 0;
for (let saltI = 0; saltI < salts.length; saltI++) {
  for (const info of infoStrs) {
    const k = Buffer.from(hkdfSync("sha256", shared, salts[saltI]!, new TextEncoder().encode(info), 16));
    for (const ivCand of [{ n: "na", iv: na }, { n: "secondField[0:12]", iv: secondField.subarray(0, 12) }]) {
      try {
        const d = createDecipheriv("aes-128-ccm", k, ivCand.iv, { authTagLength: 16 });
        d.setAuthTag(macTag);
        const cek = Buffer.concat([d.update(phi), d.final()]);
        console.log(`✅ AES-128-CCM | salt=${saltN[saltI]} info=${info || "empty"} iv=${ivCand.n} → ${cek.toString("hex")}`);
        ccmWins++;
      } catch {}
    }
  }
}
console.log(`CCM wins: ${ccmWins}, total wins: ${wins + ccmWins}`);
