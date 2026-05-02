/**
 * Diagnose `friends.refresh()` wire behavior.
 *
 * Each ACTUAL network call generates 4 log events: 2 from `native-fetch`
 * (host side) and 2 from the bundle's `shims/fetch` (sandbox side).
 * Native emits `respBytes:0` (doesn't drain); shim emits the real size.
 * Filter on `respBytes === 0` to count actual wire calls cleanly.
 *
 * Usage: bun run scripts/test-refresh.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  setLogger,
  type BrowserContext,
  type LogEvent,
} from "../src/index.ts";

type Account = {
  username: string;
  password: string;
  authPath: string;
  status?: "accepted" | "soft-blocked" | "hard-blocked";
  browser?: BrowserContext;
};

type Smoke = { accounts: Account[]; fingerprint?: { userAgent: string } };

const root = join(import.meta.dir, "..");
const smoke = JSON.parse(readFileSync(join(root, ".snapcap-smoke.json"), "utf8")) as Smoke;
const acct = smoke.accounts.find(a => a.status !== "soft-blocked" && a.status !== "hard-blocked");
if (!acct) throw new Error("no usable account in .snapcap-smoke.json");

type WireCall = { ts: number; endpoint: string; reqBytes: number };
type Phase = "init" | "refresh1" | "refresh2";

let phase: Phase = "init";
const wire: Record<Phase, WireCall[]> = { init: [], refresh1: [], refresh2: [] };
const t0 = performance.now();

setLogger((ev: LogEvent) => {
  if (ev.kind !== "net.fetch.done" && ev.kind !== "net.xhr.done") return;
  if (ev.respBytes !== 0) return;  // shim layer; skip
  const url = ev.url;
  const seg = url.split("/").pop() ?? url;
  if (seg !== "SyncFriendData" && seg !== "IncomingFriendSync") return;
  wire[phase].push({
    ts: Math.round(performance.now() - t0),
    endpoint: seg,
    reqBytes: ev.reqBytes,
  });
});

function report(label: string, calls: WireCall[]): void {
  const grouped = new Map<string, WireCall[]>();
  for (const c of calls) {
    if (!grouped.has(c.endpoint)) grouped.set(c.endpoint, []);
    grouped.get(c.endpoint)!.push(c);
  }
  console.log(`\n[${label}] ${calls.length} actual wire call(s)`);
  for (const [endpoint, list] of grouped) {
    console.log(`  ${endpoint}: ${list.length}×`);
    list.forEach((c, i) => {
      const delta = i > 0 ? `+${c.ts - list[i - 1]!.ts}ms` : `t=${c.ts}ms`;
      console.log(`    [${delta.padStart(10)}] req=${c.reqBytes}B`);
    });
  }
}

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(root, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? { userAgent: smoke.fingerprint?.userAgent ?? "Mozilla/5.0" },
});

console.log(`[diag] auth as ${acct.username}…`);
await client.authenticate();
report("init", wire.init);

phase = "refresh1";
console.log(`\n[diag] calling refresh() #1…`);
await client.friends.refresh();
report("refresh #1", wire.refresh1);

await new Promise(r => setTimeout(r, 1000));

phase = "refresh2";
console.log(`\n[diag] calling refresh() #2…`);
await client.friends.refresh();
report("refresh #2", wire.refresh2);

console.log(`\n[diag] === DEDUP ANALYSIS ===`);
for (const label of ["refresh1", "refresh2"] as const) {
  const grouped = new Map<string, number[]>();
  for (const c of wire[label]) {
    const key = `${c.endpoint}|req=${c.reqBytes}B`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c.ts);
  }
  for (const [key, timestamps] of grouped) {
    if (timestamps.length > 1) {
      const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]!);
      console.log(`  ${label}: ${timestamps.length}× ${key}  gaps: ${gaps.join(",")}ms  → IDENTICAL BYTES (safe dedup target)`);
    }
  }
}

process.exit(0);
