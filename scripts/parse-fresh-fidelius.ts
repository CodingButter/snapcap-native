/**
 * Parse the freshly-captured Fidelius envelope from the duplex WS,
 * extract per-recipient wrapped CEKs, and try to correlate which
 * recipient entry is ours.
 */
import { ProtoReader } from "../src/transport/proto-encode.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SnapcapAuthBlob } from "../src/index.ts";

// Hex captured from the WS recv:
const FRESH_HEX = "00000001e50a036d637312dd030ada030abd03084312120a10eabd1d89239a4f7bbbcc0ae3b26c52021a81029a06e4012ae1010a2b0a05516f0d7c48100a1a208bc982cc9ad8f49c9941ac311684a8978f79934cb1cbb9c1fd0db51b6c23d93e0a2b0a05305d515fc6100a1a205f46a28e337d45861dcc5a199cd85d770f82f10a5c86ed35aa2faf3d02fa0e9d0a2b0a05173206fbd5100a1a20d1fbd8a7061a480cea7c354baf9bfbab1d5fcd62af9964494a20fd4fa9795d350a2b0a051d276663b6100a1a203b6f7a98645589b6cec8e6fc7ee68cd4c59e5ed1e7c5fea6b0a45e631daddfe90a2b0a051cb699c33c100a1a20242a2757681e91444da504d1afb40132a38679e279edc57622bbfd8e13a62ab30a170a120a108fee42dfe5495727a893034382ccab8910b301227510011a472a450a0cb7ae7938162a327144dcdec3121074e2f148299c22071a2e1e67f98b3ec81a2103483d3ba2ac303985ce06f3e42f76d3ac5a17696d02fe2160436ea62f81e114d1200a2224fe0b65854eeae5ee88e0a38905dee9b4a1e167715c4f135fff9ae73e930a3133149f2cac32003802320a08bbd981cfdd3358b301388c99b4898ff4e5ae6e4a140a120a100000000000000043a893034382ccab8912180a120a10eabd1d89239a4f7bbbcc0ae3b26c520212021043";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius!;
const myPub = Buffer.from(fid.publicKey, "hex");
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);

// Strip 5-byte gRPC frame header
const all = Buffer.from(FRESH_HEX, "hex");
const frame = all.slice(5);
console.log(`gRPC frame length: ${all[1] << 24 | all[2] << 16 | all[3] << 8 | all[4]}`);
console.log(`frame body: ${frame.byteLength}B`);

dump(new Uint8Array(frame), "");

function dump(bytes: Uint8Array, prefix: string, depth = 0): void {
  if (depth > 15) { console.log(`${prefix} …max-depth`); return; }
  let r: ProtoReader;
  try { r = new ProtoReader(bytes); } catch { return; }
  for (let n = r.next(); n; n = r.next()) {
    const p = `${prefix}.f${n.field}`;
    try {
      if (n.wireType === 0) {
        console.log(`${p} = varint ${r.varint()}`);
      } else if (n.wireType === 2) {
        const inner = r.bytes();
        const isMine = inner.byteLength === 5 && Buffer.from(inner).equals(myPkid);
        if (inner.byteLength <= 64 && !looksLikeProto(inner)) {
          const hex = Buffer.from(inner).toString("hex");
          // Try string
          try {
            const s = new TextDecoder("utf-8", { fatal: true }).decode(inner);
            const printable = /^[\x20-\x7e]*$/.test(s);
            if (printable && s.length > 0) {
              console.log(`${p} = "${s}" (${inner.byteLength}B${isMine ? ", MY PKID" : ""})`);
            } else throw 0;
          } catch {
            console.log(`${p} = bytes(${inner.byteLength}B) ${hex}${isMine ? "  ← MY PKID" : ""}`);
          }
        } else {
          console.log(`${p}: bytes(${inner.byteLength}B) [submessage]`);
          dump(inner, p, depth + 1);
        }
      } else r.skip(n.wireType);
    } catch (e) {
      console.log(`${p} parse error: ${(e as Error).message}`);
      return;
    }
  }
}

function looksLikeProto(b: Uint8Array): boolean {
  try {
    let p = 0, n = 0;
    while (p < b.byteLength && n < 50) {
      let tag = 0, s = 0, c = true;
      while (c) {
        if (p >= b.byteLength) return false;
        const v = b[p++]!;
        tag |= (v & 0x7f) << s; c = (v & 0x80) !== 0; s += 7;
      }
      const wt = tag & 7, field = tag >> 3;
      if (field < 1 || field > 100000) return false;
      if (wt === 0) {
        let c = true;
        while (c) { if (p >= b.byteLength) return false; c = (b[p++]! & 0x80) !== 0; }
      } else if (wt === 2) {
        let len = 0, ss = 0, cc = true;
        while (cc) { if (p >= b.byteLength) return false; const v = b[p++]!; len |= (v & 0x7f) << ss; cc = (v & 0x80) !== 0; ss += 7; }
        if (p + len > b.byteLength) return false; p += len;
      } else if (wt === 1) { if (p + 8 > b.byteLength) return false; p += 8; }
      else if (wt === 5) { if (p + 4 > b.byteLength) return false; p += 4; }
      else return false;
      n++;
    }
    return p === b.byteLength;
  } catch { return false; }
}
