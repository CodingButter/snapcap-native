#!/usr/bin/env bun
/**
 * listen-60s.ts — auth perdyjamie, subscribe to inbound, sit for 60s.
 *
 * While running: open Snapchat on your phone, open the jamie_nichols
 * thread, type a message, send it. Every WS frame coming back through
 * our duplex shim will surface as `[ws.shim] MSG ...` lines. Every
 * decrypted plaintext message will surface as `← jamie: ...`.
 *
 * Diagnostic goal: confirm whether ANY inbound traffic flows through
 * our shim — if not, the WS we're seeing is a phantom and inbound
 * messages must be arriving via a different transport.
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
const acct = SMOKE.accounts.find((a) => a.username === "perdyjamie")!;
const JAMIE_NICHOLS_CONV = process.env.CONV_ID
  ?? "8fee42df-e549-5727-a893-034382ccab89";

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

client.messaging.on("message", (msg: PlaintextMessage) => {
  const dir = msg.isSender ? "→" : "←";
  const conv = (msg.raw as { conversationId?: string }).conversationId;
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(msg.content);
  const text = utf8.replace(/^[\x00-\x1f]+/, "").replace(/[\x00-\x08\x0b-\x1f]+$/g, "").trim();
  log(`[${stamp()}] ${dir} conv=${conv?.slice(0, 8) ?? "?"}: ${text}`);
});

log(`[${stamp()}] LISTENING for 60s — type and send from your phone now`);
log(`[${stamp()}] Watch for [ws.shim] MSG lines (= raw WS frames inbound)`);
await sleep(60_000);

log(`[${stamp()}] === done ===`);
process.exit(0);
