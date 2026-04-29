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

log("\n[receive] listing conversations…");
const convs = await client.getConversations();
log(`[receive] ${convs.length} conversations`);

for (const conv of convs.slice(0, 10)) {
  const others = conv.participants.filter((p) => p.userId !== client.self?.userId);
  const label = others.map((u) => u.username ?? u.userId.slice(0, 8)).join(", ");
  log(`\n[receive] querying conv ${conv.conversationId.slice(0, 8)} (${label})`);
  let resp;
  try {
    resp = await client.fetchMessages(conv.conversationId);
  } catch (e) {
    log(`  fetchMessages threw: ${(e as Error).message.slice(0, 200)}`);
    continue;
  }
  log(`  raw response: ${resp.raw.byteLength} bytes`);
  if (resp.raw.byteLength === 0) continue;
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
  if (depth > 6) {
    process.stderr.write(`${indent}…too deep\n`);
    return;
  }
  const r = new ProtoReader(bytes);
  for (let n = r.next(); n; n = r.next()) {
    if (n.wireType === 0) {
      const v = r.varint();
      process.stderr.write(`${indent}f${n.field} varint = ${v}\n`);
    } else if (n.wireType === 2) {
      const inner = r.bytes();
      // Heuristic: if it looks like a sub-message, recurse; else dump as bytes
      const looksProto = inner.byteLength >= 2 && inner[0]! < 0x80 && (inner[0]! & 0x07) <= 5;
      if (looksProto && inner.byteLength > 4) {
        process.stderr.write(`${indent}f${n.field} sub(${inner.byteLength}B):\n`);
        walkProto(inner, indent + "  ", depth + 1);
      } else {
        const hex = Buffer.from(inner).toString("hex");
        process.stderr.write(`${indent}f${n.field} bytes(${inner.byteLength}) = ${hex.slice(0, 80)}${hex.length > 80 ? "…" : ""}\n`);
      }
    } else {
      r.skip(n.wireType);
    }
  }
}

process.exit(0);
