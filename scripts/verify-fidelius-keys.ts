/**
 * Verify our key assumptions about an inbound Fidelius message:
 * 1. Does my pkid (SHA256(myPub)[0:5]) match one of the 5 recipient
 *    entries in the message?
 * 2. Does the sender pubkey (in PHI prelude f4.f3.f5.f3) decompress to
 *    a real sender's pubkey from our friend list?
 * 3. Does our ECDH(myPriv, senderPub) shared secret look reasonable?
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const fid = blob.fidelius;
if (!fid) throw new Error("no fidelius in blob");
const myPub = hexToBytes(fid.publicKey);
const myPkid = createHash("sha256").update(myPub).digest().subarray(0, 5);
console.log(`my pubkey:  ${fid.publicKey.slice(0, 32)}…`);
console.log(`my pkid:    ${Buffer.from(myPkid).toString("hex")}`);

const data = readFileSync("/tmp/inbox_8fee42df.bin");
console.log(`\ninbound: ${data.byteLength}B`);

const top = new ProtoReader(new Uint8Array(data));
let f1: Uint8Array | null = null;
for (let n = top.next(); n; n = top.next()) {
  if (n.field === 1 && n.wireType === 2) f1 = top.bytes();
  else top.skip(n.wireType);
}
if (!f1) throw new Error("no top f1");

let f3: Uint8Array | null = null;
let f4: Uint8Array | null = null;
const r1 = new ProtoReader(f1);
for (let n = r1.next(); n; n = r1.next()) {
  if (n.field === 3 && n.wireType === 2) f3 = r1.bytes();
  else if (n.field === 4 && n.wireType === 2) f4 = r1.bytes();
  else r1.skip(n.wireType);
}
if (!f3 || !f4) throw new Error("missing f3 or f4");

console.log(`\n--- recipient entries ---`);
const r3 = new ProtoReader(f3);
const recipients: Array<{ pkid: Uint8Array; version: bigint; wrapped: Uint8Array }> = [];
for (let n = r3.next(); n; n = r3.next()) {
  if (n.field === 99 && n.wireType === 2) {
    const f99 = new ProtoReader(r3.bytes());
    for (let m = f99.next(); m; m = f99.next()) {
      if (m.field === 5 && m.wireType === 2) {
        const f99f5 = new ProtoReader(f99.bytes());
        for (let k = f99f5.next(); k; k = f99f5.next()) {
          if (k.field === 1 && k.wireType === 2) {
            const e = new ProtoReader(f99f5.bytes());
            let pkid = new Uint8Array(0), version = 0n, wrapped = new Uint8Array(0);
            for (let f = e.next(); f; f = e.next()) {
              if (f.field === 1 && f.wireType === 2) pkid = e.bytes();
              else if (f.field === 2 && f.wireType === 0) version = e.varint();
              else if (f.field === 3 && f.wireType === 2) wrapped = e.bytes();
              else e.skip(f.wireType);
            }
            recipients.push({ pkid: new Uint8Array(pkid), version, wrapped: new Uint8Array(wrapped) });
          } else f99f5.skip(k.wireType);
        }
      } else f99.skip(m.wireType);
    }
  } else r3.skip(n.wireType);
}
let myEntry: typeof recipients[number] | null = null;
for (const r of recipients) {
  const isMe = bufferEq(r.pkid, myPkid);
  console.log(`  pkid=${Buffer.from(r.pkid).toString("hex")} v=${r.version} wrapped=${r.wrapped.byteLength}B ${isMe ? "← ME!" : ""}`);
  if (isMe) myEntry = r;
}
if (!myEntry) {
  console.log(`\n❌ none of the recipient pkids match my pkid ${Buffer.from(myPkid).toString("hex")}`);
  console.log(`This message is NOT addressed to us — wrong message or wrong account.`);
  process.exit(1);
}

// Sender pubkey from PHI prelude.
let senderPub = new Uint8Array(0);
let na = new Uint8Array(0), secondField = new Uint8Array(0);
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
          else if (k.field === 3 && k.wireType === 2) senderPub = inner.bytes();
          else inner.skip(k.wireType);
        }
      } else f4f3.skip(m.wireType);
    }
  } else r4.skip(n.wireType);
}
console.log(`\nsender pubkey (compressed, 33B): ${Buffer.from(senderPub).toString("hex")}`);
console.log(`na (12B):                        ${Buffer.from(na).toString("hex")}`);
console.log(`secondField (16B):               ${Buffer.from(secondField).toString("hex")}`);

// pkid of sender = SHA256(decompressed senderPub)[0:5]
// We can compute this *if* we decompress; but if we look it up against
// our friend list, it should match a friend.
console.log(`\n--- looking up sender in friend list ---`);
const client = await SnapcapClient.fromAuth({ auth: blob });
const friends = await client.listFriends();
console.log(`have ${friends.length} friends. Looking for sender pubkey…`);
let found = false;
for (const f of friends) {
  if (!f.fideliusPublicKey) continue;
  // friend.fideliusPublicKey is base64 of 65B uncompressed point
  const friendPubBytes = Buffer.from(f.fideliusPublicKey, "base64");
  const compressed = compressP256(new Uint8Array(friendPubBytes));
  const friendPkid = createHash("sha256").update(friendPubBytes).digest().subarray(0, 5);
  if (bufferEq(compressed, senderPub)) {
    console.log(`  ✅ sender pubkey matches: ${f.username} (${f.userId})`);
    console.log(`     friendPkid[0:5] = ${Buffer.from(friendPkid).toString("hex")}`);
    found = true;
  }
}
if (!found) {
  console.log(`  ❌ sender pubkey NOT found in friend list`);
  console.log(`  → this means the sender pubkey in PHI prelude is EPHEMERAL, not identity`);
  console.log(`  → if so, ECDH(myPriv, senderPub) IS a valid shared secret, but the wrap key`);
  console.log(`     derivation may use a different KDF input than what we tried`);
}

function compressP256(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.byteLength !== 65 || uncompressed[0] !== 0x04) {
    throw new Error(`expected 65B uncompressed P-256, got ${uncompressed.byteLength}B`);
  }
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);
  const yLast = y[y.byteLength - 1] ?? 0;
  const out = new Uint8Array(33);
  out[0] = (yLast & 1) ? 0x03 : 0x02;
  out.set(x, 1);
  return out;
}
function bufferEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
