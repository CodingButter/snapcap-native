#!/usr/bin/env bun
/**
 * chat-jamie.ts — interactive-style script: send jamie_nichols a message,
 * wait for a reply, print decrypted plaintext.
 *
 * Auths perdyjamie via the SDK, brings up the messaging session, fires one
 * sendText into the perdyjamie ↔ jamie_nichols conversation, and prints
 * every inbound message that arrives over the next 60 seconds.
 *
 * Usage:
 *   bun run scripts/chat-jamie.ts
 *   bun run scripts/chat-jamie.ts "custom outgoing text"
 *
 * Throttle: ONE send per invocation. Snap rate-limits aggressively; do
 * not run this in a tight loop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  RECOMMENDED_THROTTLE_RULES,
  type PlaintextMessage,
} from "../src/index.ts";

const SDK_ROOT = join(import.meta.dir, "..");
const SMOKE = JSON.parse(readFileSync(join(SDK_ROOT, ".snapcap-smoke.json"), "utf8")) as {
  accounts: { username: string; password: string; authPath: string }[];
  fingerprint?: { userAgent: string };
};

// Hardcoded conversation between perdyjamie and jamie_nichols. Captured
// from prior diagnostics; survives session boundaries because Snap keys
// conversations by UUID. Override via env if you want to retarget.
const JAMIE_NICHOLS_CONV = process.env.CONV_ID
  ?? "8fee42df-e549-5727-a893-034382ccab89";

const acct = SMOKE.accounts.find((a) => a.username === "perdyjamie");
if (!acct) {
  console.error("[chat-jamie] perdyjamie not in .snapcap-smoke.json");
  process.exit(1);
}

const outgoingText = process.argv[2] ?? `claude here — auto-reply test ${Date.now()}`;

// Suppress the bundle's benign init throw (vm.Context realm artifact).
process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes("setAttribute") || msg.includes("ei.setAttribute")) return;
  process.stderr.write(`[unhandledRejection] ${msg}\n`);
});

const log = (s: string): void => process.stderr.write(s + "\n");
const stamp = () => new Date().toISOString().slice(11, 23);

// ── Boot SnapcapClient ──────────────────────────────────────────────
const client = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: {
    userAgent:
      SMOKE.fingerprint?.userAgent
      ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  },
  throttle: { rules: RECOMMENDED_THROTTLE_RULES },
});

log(`[${stamp()}] authenticating perdyjamie…`);
await client.authenticate();
log(`[${stamp()}] authed.`);

// ── Subscribe BEFORE sending so the reply doesn't slip past us ─────
const inboundSeen: PlaintextMessage[] = [];
client.messaging.on("message", (msg) => {
  if (msg.isSender !== false) return;          // only inbound
  const conv = (msg.raw as { conversationId?: string }).conversationId;
  if (conv && conv !== JAMIE_NICHOLS_CONV) return;  // filter to jamie's conv

  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(msg.content);
  // Snap's text-DM content is a proto envelope: drop leading/trailing
  // non-printable framing so the actual text reads cleanly.
  const text = utf8.replace(/^[\x00-\x1f]+/, "").replace(/[\x00-\x08\x0b-\x1f]+$/g, "").trim();

  inboundSeen.push(msg);
  process.stdout.write(`\n[${stamp()}] ← jamie_nichols: ${text}\n`);
});

// ── Fire the send ───────────────────────────────────────────────────
log(`[${stamp()}] → sending: "${outgoingText}"`);
const messageId = await client.messaging.sendText(JAMIE_NICHOLS_CONV, outgoingText);
log(`[${stamp()}] sent (id=${messageId.slice(0, 8)}…)`);

// ── Wait for replies ────────────────────────────────────────────────
const WAIT_MS = 60_000;
log(`[${stamp()}] waiting up to ${WAIT_MS / 1000}s for reply…`);
const startedAt = Date.now();
while (Date.now() - startedAt < WAIT_MS) {
  await new Promise((r) => setTimeout(r, 500));
}

log(`\n[${stamp()}] === done ===`);
log(`[${stamp()}] inbound captured: ${inboundSeen.length}`);
process.exit(0);
