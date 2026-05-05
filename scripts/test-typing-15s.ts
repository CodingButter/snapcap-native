#!/usr/bin/env bun
/**
 * test-typing-15s.ts — fire setTyping for 15 seconds against
 * jamie_nichols's conversation. Watch your phone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  RECOMMENDED_THROTTLE_RULES,
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
  console.error("[test-typing] perdyjamie not in .snapcap-smoke.json");
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes("setAttribute") || msg.includes("ei.setAttribute")) return;
  process.stderr.write(`[unhandledRejection] ${msg}\n`);
});

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (s: string): void => {
  process.stderr.write(s + "\n");
};

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: {
    userAgent: SMOKE.fingerprint?.userAgent
      ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  },
  throttle: { rules: RECOMMENDED_THROTTLE_RULES },
});

log(`[${stamp()}] authenticating perdyjamie…`);
await client.authenticate();
log(`[${stamp()}] authed.`);

const typingMs = Number(process.env.TYPING_MS ?? 15_000);
log(`[${stamp()}] → setTyping(${JAMIE_NICHOLS_CONV.slice(0, 8)}…, ${typingMs}ms) — WATCH PHONE NOW`);
const tStart = Date.now();
await client.messaging.setTyping(JAMIE_NICHOLS_CONV, typingMs);
log(`[${stamp()}] typing window closed after ${Date.now() - tStart}ms. Did you see dots?`);

// Sanity check: send an actual message. If this arrives on your phone,
// we know the code path executed and the WS is alive. Compare the
// [ws.shim] SEND lines for THIS send against the (missing?) ones for
// the typing pulses to localize where the typing path goes silent.
const text = `typing-test ${Date.now()}`;
log(`[${stamp()}] → sendText("${text}")`);
const id = await client.messaging.sendText(JAMIE_NICHOLS_CONV, text);
log(`[${stamp()}] sent id=${id.slice(0, 8)}…`);

process.exit(0);
