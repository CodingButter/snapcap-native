/**
 * Audit each conversation: are messages plaintext (kind=8 / older) or
 * Fidelius-encrypted (kind=149 / newer)? Tells us how much value we
 * deliver by shipping a plaintext-only reader vs needing Fidelius.
 */
import { readFileSync } from "node:fs";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const client = await SnapcapClient.fromAuth({ auth: blob });
const friends = await client.listFriends();
const friendByUid = new Map(friends.map((f) => [f.userId, f]));
const convs = await client.getConversations();

log(`auditing ${convs.length} conversations…\n`);
let plaintextCount = 0, encryptedCount = 0, otherCount = 0;

for (const conv of convs) {
  const others = conv.participants.filter((p) => p.userId !== client.self?.userId);
  const label = others.map((u) => friendByUid.get(u.userId)?.username ?? u.userId.slice(0, 8)).join(", ");
  // Ask for full history (what we know works for both varieties).
  let resp;
  try {
    resp = await client.fetchMessages(conv.conversationId, { limit: 1000, secondary: 1 });
  } catch (e) {
    log(`  ${conv.conversationId.slice(0, 8)} ${label} → fetch threw: ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  if (resp.raw.byteLength < 30) {
    log(`  ${conv.conversationId.slice(0, 8)} ${label} → empty (${resp.raw.byteLength}B)`);
    continue;
  }

  // Each conv response contains one or more "envelope" messages at the
  // top level. We classify by:
  //   - presence of f3.f99 (Fidelius envelope) → encrypted
  //   - presence of plaintext UTF-8 strings deep in proto → plaintext
  let hasFidelius = false, hasPlaintext = false, plaintextSample = "";
  walkProto(resp.raw, (path, value) => {
    if (path.endsWith(".f3.f99") || path.endsWith(".f99")) hasFidelius = true;
    if (typeof value === "string" && value.length >= 4) {
      // skip proto type-id strings + URLs that always appear (story landing url, base64, etc.)
      if (!plaintextSample && !value.startsWith("http") && !/^[A-Za-z0-9+/=]+$/.test(value)) {
        hasPlaintext = true;
        plaintextSample = value;
      }
    }
  });

  let cls = "other";
  if (hasFidelius && !hasPlaintext) cls = "🔒 encrypted-only";
  else if (hasPlaintext && !hasFidelius) cls = "📖 plaintext-only";
  else if (hasFidelius && hasPlaintext) cls = "🔀 mixed";
  if (cls.includes("encrypted")) encryptedCount++;
  else if (cls.includes("plaintext")) plaintextCount++;
  else otherCount++;

  const sample = plaintextSample.slice(0, 50);
  log(`  ${conv.conversationId.slice(0, 8)} ${label.padEnd(20)} ${cls}${sample ? `  [${sample}]` : ""}`);
}

log(`\nsummary: ${plaintextCount} plaintext-only, ${encryptedCount} encrypted-only, ${otherCount} other`);

function walkProto(bytes: Uint8Array, visit: (path: string, value: unknown) => void, path = "", depth = 0): void {
  if (depth > 10) return;
  let r;
  try { r = new ProtoReader(bytes); } catch { return; }
  for (let n = r.next(); n; n = r.next()) {
    try {
      const p = `${path}.f${n.field}`;
      if (n.wireType === 0) {
        visit(p, r.varint());
      } else if (n.wireType === 2) {
        const inner = r.bytes();
        visit(p, inner);
        // Sub-message?
        if (inner.byteLength >= 2 && looksLikeProto(inner)) {
          walkProto(inner, visit, p, depth + 1);
        } else {
          // Try string
          try {
            const s = new TextDecoder("utf-8", { fatal: true }).decode(inner);
            visit(p, s);
          } catch {}
        }
      } else r.skip(n.wireType);
    } catch { return; }
  }
}

function looksLikeProto(b: Uint8Array): boolean {
  try {
    let p = 0, n = 0;
    while (p < b.byteLength && n < 50) {
      let tag = 0; let s = 0; let c = true;
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

process.exit(0);
