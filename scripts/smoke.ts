/**
 * Smoke test for SnapcapClient.
 *
 * Phase A: cold-start (no DataStore yet) → isAuthorized() runs full
 *          login → listFriends → DataStore is now warm.
 * Phase B: same DataStore, no creds → isAuthorized() short-circuits on
 *          restored cookies → listFriends works without re-login.
 *
 * Phase A asserts the full native login + bearer mint + API call works.
 * Phase B asserts the auth state is reusable across processes (for the
 * persistence story).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";

const SDK_STATE_PATH = process.env.SNAP_STATE_FILE ??
  join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  username: string;
  password: string;
  fingerprint?: { userAgent: string };
};
const STORE_PATH = join(import.meta.dir, "..", ".tmp_auth", "auth.json");

console.log(`[smoke] === Phase A: cold-start (DataStore=${STORE_PATH}) ===`);
const dataStoreA = new FileDataStore(STORE_PATH);
const t0 = Date.now();
const clientA = new SnapcapClient({
  dataStore: dataStoreA,
  username: state.username,
  password: state.password,
  userAgent: state.fingerprint?.userAgent,
});
const okA = await clientA.isAuthorized();
console.log(`[smoke] isAuthorized (cold): ${okA} (${Date.now() - t0}ms)`);
if (!okA) throw new Error("Phase A: isAuthorized() returned false");

console.log(`[smoke] listFriends()…`);
const t1 = Date.now();
const friends = await clientA.listFriends();
console.log(`[smoke] listFriends: ${Date.now() - t1}ms`);
console.log(`[smoke] Phase A response summary: ${summarizeFriends(friends)}`);

console.log(`\n[smoke] === Phase B: warm-start (reuse DataStore, no creds) ===`);
const dataStoreB = new FileDataStore(STORE_PATH);
const t2 = Date.now();
const clientB = new SnapcapClient({ dataStore: dataStoreB });
const okB = await clientB.isAuthorized();
console.log(`[smoke] isAuthorized (warm): ${okB} (${Date.now() - t2}ms)`);
if (!okB) throw new Error("Phase B: isAuthorized() returned false on warm start");

console.log(`[smoke] listFriends() (reused session)…`);
const t3 = Date.now();
const friends2 = await clientB.listFriends();
console.log(`[smoke] listFriends: ${Date.now() - t3}ms`);
console.log(`[smoke] Phase B response summary: ${summarizeFriends(friends2)}`);

console.log(`\n[smoke] SDK working end-to-end`);
process.exit(0);

function summarizeFriends(r: unknown): string {
  if (Array.isArray(r)) return `users[${r.length}]`;
  if (!r || typeof r !== "object") return String(r);
  const obj = r as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
    else if (v && typeof v === "object") parts.push(`${k}{${Object.keys(v).length}}`);
    else if (typeof v === "string") parts.push(`${k}="${v.slice(0, 30)}${v.length > 30 ? "…" : ""}"`);
    else parts.push(`${k}=${v}`);
  }
  return parts.join(", ");
}
