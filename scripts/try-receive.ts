/**
 * Inbox smoke: list conversations, query each for recent messages,
 * surface any Fidelius-encrypted envelopes addressed to our identity,
 * and try to decrypt them.
 *
 * Usage:
 *   bun run scripts/try-receive.ts
 *
 * Prereqs:
 *   - /tmp/snapcap-smoke-auth.json contains a fresh auth blob with a
 *     populated `fidelius` field. If you've never registered Fidelius
 *     for this account from the SDK, run `bun run scripts/smoke.ts`
 *     first (when smoke is updated to mint Fidelius — for now just
 *     run fromCredentials manually with the SDK's new flow).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";
import { decodeFideliusEnvelope, decryptFideliusEnvelope } from "../src/api/inbox.ts";
import { ProtoReader } from "../src/transport/proto-encode.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const client = await SnapcapClient.fromAuth({ auth: blob });
log(`[receive] auth restored. self=${client.self?.username} (${client.self?.userId})`);
log(`[receive] fidelius identity: ${client.fidelius ? "present" : "MISSING — re-login with fromCredentials"}`);

if (!client.fidelius) {
  log("[receive] cannot proceed without Fidelius identity. Exiting.");
  process.exit(1);
}

log("\n[receive] resolving friends to enrich conv labels…");
const friends = await client.listFriends();
const friendByUid = new Map(friends.map((f) => [f.userId, f]));
log(`[receive] ${friends.length} friends loaded`);

log("\n[receive] listing conversations…");
const convs = await client.getConversations();
log(`[receive] ${convs.length} conversations`);

for (const conv of convs.slice(0, 10)) {
  const others = conv.participants.filter((p) => p.userId !== client.self?.userId);
  const label = others.map((u) => {
    const f = friendByUid.get(u.userId);
    return f?.username ?? u.username ?? u.userId.slice(0, 12);
  }).join(", ");
  const lastActiv = conv.lastActivityAt ? conv.lastActivityAt.toISOString() : "never";
  log(`\n[receive] conv ${conv.conversationId.slice(0, 8)} (${label}) last=${lastActiv}`);
  // Try a few param variants to find one that returns full history.
  let resp;
  let usedParams = "default";
  for (const params of [
    { label: "default(21,100)", opts: undefined },
    { label: "limit=1000,sec=0", opts: { limit: 1000, secondary: 0 } },
    { label: "limit=1000,sec=1", opts: { limit: 1000, secondary: 1 } },
    { label: "limit=1000,sec=99999", opts: { limit: 1000, secondary: 99999 } },
  ]) {
    try {
      const r = await client.fetchMessages(conv.conversationId, params.opts);
      if (r.raw.byteLength > 30) {
        resp = r;
        usedParams = params.label;
        break;
      }
      if (!resp) { resp = r; usedParams = params.label; }
    } catch (e) {
      log(`  ${params.label} threw: ${(e as Error).message.slice(0, 150)}`);
    }
  }
  if (!resp) continue;
  log(`  using ${usedParams}`);
  log(`  raw response: ${resp.raw.byteLength} bytes`);
  // Always save the response — even empty 2-byte ones — for diffing.
  writeFileSync(`/tmp/inbox_${conv.conversationId.slice(0, 8)}_${(others[0]?.userId ?? "self").slice(0, 8)}.bin`, resp.raw);
  if (resp.raw.byteLength < 30) {
    log(`  hex: ${Buffer.from(resp.raw).toString("hex")}`);
    continue;
  }

  // Look for a Fidelius envelope inside. We don't know the full response
  // shape yet, so do a tolerant walk and dump field tags + sizes.
  log(`  hex (first 64): ${Buffer.from(resp.raw.slice(0, 64)).toString("hex")}`);
  writeFileSync(`/tmp/inbox_${conv.conversationId.slice(0, 8)}.bin`, resp.raw);
  log(`  saved to /tmp/inbox_${conv.conversationId.slice(0, 8)}.bin`);
  walkProto(resp.raw, "    ");
}

function walkProto(bytes: Uint8Array, indent: string, depth = 0): void {
  if (depth > 8) {
    process.stderr.write(`${indent}…too deep\n`);
    return;
  }
  const r = new ProtoReader(bytes);
  for (let n = r.next(); n; n = r.next()) {
    try {
      if (n.wireType === 0) {
        const v = r.varint();
        process.stderr.write(`${indent}f${n.field} varint = ${v}\n`);
      } else if (n.wireType === 2) {
        const inner = r.bytes();
        if (looksLikeProto(inner)) {
          process.stderr.write(`${indent}f${n.field} sub(${inner.byteLength}B):\n`);
          walkProto(inner, indent + "  ", depth + 1);
        } else if (looksLikeUtf8(inner)) {
          process.stderr.write(`${indent}f${n.field} str(${inner.byteLength}) = ${JSON.stringify(new TextDecoder().decode(inner))}\n`);
        } else {
          const hex = Buffer.from(inner).toString("hex");
          process.stderr.write(`${indent}f${n.field} bytes(${inner.byteLength}) = ${hex.slice(0, 80)}${hex.length > 80 ? "…" : ""}\n`);
        }
      } else {
        r.skip(n.wireType);
      }
    } catch (e) {
      process.stderr.write(`${indent}!parse error: ${(e as Error).message.slice(0, 80)}\n`);
      return;
    }
  }
}

function looksLikeProto(b: Uint8Array): boolean {
  if (b.byteLength < 2) return false;
  // Validate by trying to read tags + skip — must consume entire buffer.
  try {
    let p = 0;
    let consumed = 0;
    while (p < b.byteLength) {
      let tag = 0; let shift = 0; let cont = true;
      while (cont) {
        if (p >= b.byteLength) return false;
        const v = b[p++]!;
        tag |= (v & 0x7f) << shift;
        cont = (v & 0x80) !== 0;
        shift += 7;
      }
      const wt = tag & 7;
      const field = tag >> 3;
      if (field < 1 || field > 100000) return false;
      if (wt === 0) {
        let cont = true;
        while (cont) {
          if (p >= b.byteLength) return false;
          cont = (b[p++]! & 0x80) !== 0;
        }
      } else if (wt === 2) {
        let len = 0; let s = 0; let c = true;
        while (c) {
          if (p >= b.byteLength) return false;
          const v = b[p++]!;
          len |= (v & 0x7f) << s;
          c = (v & 0x80) !== 0;
          s += 7;
        }
        if (p + len > b.byteLength) return false;
        p += len;
      } else if (wt === 1) {
        if (p + 8 > b.byteLength) return false;
        p += 8;
      } else if (wt === 5) {
        if (p + 4 > b.byteLength) return false;
        p += 4;
      } else return false;
      consumed++;
      if (consumed > 200) break;
    }
    return p === b.byteLength;
  } catch { return false; }
}

function looksLikeUtf8(b: Uint8Array): boolean {
  if (b.byteLength === 0 || b.byteLength > 4096) return false;
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
    // mostly printable
    let printable = 0;
    for (const c of s) {
      const code = c.codePointAt(0)!;
      if (code >= 0x20 && code <= 0x7e) printable++;
      else if (code >= 0xa0) printable++;
    }
    return printable / s.length > 0.85;
  } catch { return false; }
}

process.exit(0);
