#!/usr/bin/env bun
/**
 * test-presence-states.ts — exercise viewing / typing / read primitives
 * end-to-end against perdyjamie ↔ jamie_nichols, one phase at a time,
 * with visible cues for the human watching their phone.
 *
 * Phases (~35s total):
 *   1. setViewing(5s)  — recipient should see your bitmoji pose change
 *                        ("in chat" indicator) for 5s, then revert
 *   2. setTyping(5s)   — recipient should see "perdyjamie is typing…"
 *                        dots for 5s, then they vanish
 *   3. setRead          — wait up to 20s for an inbound message; on receipt,
 *                        mark it read; recipient's "delivered" should flip
 *                        to "opened"
 *
 * Usage:
 *   bun run scripts/test-presence-states.ts
 *
 * Throttle: ONE auth + ONE of each primitive per invocation. Snap rate-
 * limits aggressively; do not loop this script.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

const JAMIE_NICHOLS_CONV = process.env.CONV_ID
  ?? "8fee42df-e549-5727-a893-034382ccab89";

const acct = SMOKE.accounts.find((a) => a.username === "perdyjamie");
if (!acct) {
  console.error("[test-presence] perdyjamie not in .snapcap-smoke.json");
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes("setAttribute") || msg.includes("ei.setAttribute")) return;
  process.stderr.write(`[unhandledRejection] ${msg}\n`);
});

const log = (s: string): void => {
  process.stderr.write(s + "\n");
};
const stamp = () => new Date().toISOString().slice(11, 23);
const phase = (n: number, title: string) => {
  log("");
  log(`──────────────────────────────────────────────────────────────`);
  log(`  Phase ${n} — ${title}`);
  log(`──────────────────────────────────────────────────────────────`);
};

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

// Subscribe BEFORE we kick anything off so the inbound for phase 3 doesn't slip past.
let firstInbound: PlaintextMessage | undefined;
const inboundReceived = Promise.withResolvers<PlaintextMessage>();
client.messaging.on("message", (msg) => {
  if (msg.isSender !== false) return;
  const conv = (msg.raw as { conversationId?: string }).conversationId;
  if (conv && conv !== JAMIE_NICHOLS_CONV) return;
  if (firstInbound) return;
  firstInbound = msg;
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(msg.content);
  const text = utf8.replace(/^[\x00-\x1f]+/, "").replace(/[\x00-\x08\x0b-\x1f]+$/g, "").trim();
  log(`\n[${stamp()}] ← jamie_nichols: ${text}`);
  inboundReceived.resolve(msg);
});

// ─── Phase 1: setViewing ────────────────────────────────────────────
phase(1, "setViewing(5s) — watch jamie's chat for your in-chat indicator");
log(`[${stamp()}] → setViewing(${JAMIE_NICHOLS_CONV.slice(0, 8)}…, 5_000ms)`);
await client.messaging.setViewing(JAMIE_NICHOLS_CONV, 5_000);
log(`[${stamp()}] viewing window closed (recipient idle timer ~3s).`);
await sleep(2_000);

// ─── Phase 2: setTyping ─────────────────────────────────────────────
phase(2, "setTyping(5s) — watch for 'perdyjamie is typing…' dots");
log(`[${stamp()}] → setTyping(${JAMIE_NICHOLS_CONV.slice(0, 8)}…, 5_000ms)`);
await client.messaging.setTyping(JAMIE_NICHOLS_CONV, 5_000);
log(`[${stamp()}] typing window closed.`);
await sleep(2_000);

// ─── Phase 3: setRead ───────────────────────────────────────────────
phase(3, "setRead — send a message from your phone; we mark it read on receipt");
log(`[${stamp()}] waiting up to 20s for inbound…`);

const winner = await Promise.race([
  inboundReceived.promise,
  sleep(20_000).then(() => undefined),
]);

if (!winner) {
  log(`[${stamp()}] no inbound within 20s — skipping setRead phase.`);
} else {
  const messageId = (winner.raw as { messageId?: string | bigint }).messageId
    ?? (winner.raw as { id?: string | bigint }).id;
  if (!messageId) {
    log(`[${stamp()}] inbound msg lacked extractable messageId — keys: ${Object.keys(winner.raw as object).join(",")}`);
  } else {
    log(`[${stamp()}] → setRead(${JAMIE_NICHOLS_CONV.slice(0, 8)}…, ${String(messageId).slice(0, 16)}…)`);
    await client.messaging.setRead(JAMIE_NICHOLS_CONV, messageId);
    log(`[${stamp()}] read receipt sent. Check your phone — message should flip to 'opened'.`);
  }
}

log(`\n[${stamp()}] === done ===`);
process.exit(0);
