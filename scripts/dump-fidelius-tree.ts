/**
 * Dump the full proto tree of one Fidelius-encrypted inbound message
 * so we can see EVERY field per recipient (not just the 3 we'd been
 * tracking). Goal: confirm whether `salt` and `macTag` show up as
 * separate proto fields per FideliusRecipientInfo.
 */
import { readFileSync } from "node:fs";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const path = process.argv[2] ?? "/tmp/inbox_8fee42df.bin";
const data = new Uint8Array(readFileSync(path));
console.log(`file: ${path} (${data.byteLength}B)`);

walk(data, "");

function walk(b: Uint8Array, prefix: string, depth = 0): void {
  if (depth > 12) { console.log(`${prefix}…(deep)`); return; }
  let r: ProtoReader;
  try { r = new ProtoReader(b); } catch { return; }
  for (let n = r.next(); n; n = r.next()) {
    const p = `${prefix}.f${n.field}`;
    try {
      if (n.wireType === 0) {
        const v = r.varint();
        console.log(`${p} = varint ${v}`);
      } else if (n.wireType === 1) {
        const v = r.fixed64();
        console.log(`${p} = fixed64 ${v}`);
      } else if (n.wireType === 5) {
        const v = r.fixed32();
        console.log(`${p} = fixed32 ${v}`);
      } else if (n.wireType === 2) {
        const inner = r.bytes();
        if (inner.byteLength === 0) {
          console.log(`${p} = bytes(0)`);
        } else if (looksLikeProto(inner)) {
          console.log(`${p}: bytes(${inner.byteLength}B) [submessage]`);
          walk(inner, p, depth + 1);
        } else {
          try {
            const s = new TextDecoder("utf-8", { fatal: true }).decode(inner);
            const printable = /^[\x20-\x7e]*$/.test(s);
            if (printable) console.log(`${p} = string(${inner.byteLength}B) ${JSON.stringify(s)}`);
            else throw 0;
          } catch {
            const hex = Buffer.from(inner).toString("hex");
            console.log(`${p} = bytes(${inner.byteLength}B) ${hex.slice(0, 80)}${hex.length > 80 ? "…" : ""}`);
          }
        }
      } else {
        console.log(`${p} = wire-${n.wireType}`);
        r.skip(n.wireType);
      }
    } catch (e) {
      console.log(`${p} = (parse error: ${(e as Error).message})`);
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
