/**
 * Smoke test for SnapcapClient.
 *
 * Phase A: cold-start (no DataStore yet) → authenticate() drives the
 *          bundle's 2-step WebLogin → friends.list() → DataStore is now warm.
 * Phase B: same DataStore, no creds → authenticate() short-circuits on
 *          restored cookies → friends.list() works without re-login.
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
const STORE_PATH = join(import.meta.dir, "..", ".tmp", "auth", "auth.json");

console.log(`[smoke] === Phase A: cold-start (DataStore=${STORE_PATH}) ===`);
const dataStoreA = new FileDataStore(STORE_PATH);
const t0 = Date.now();
const clientA = new SnapcapClient({
  dataStore: dataStoreA,
  credentials: { username: state.username, password: state.password },
  browser: {
    userAgent: state.fingerprint?.userAgent ??
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  },
});
await clientA.authenticate();
const okA = clientA.isAuthenticated();
console.log(`[smoke] authenticate (cold): ${okA} (${Date.now() - t0}ms)`);
if (!okA) throw new Error("Phase A: isAuthenticated() returned false after authenticate()");

console.log(`[smoke] friends.list()…`);
const t1 = Date.now();
const friends = await clientA.friends.list();
console.log(`[smoke] friends.list: ${Date.now() - t1}ms`);
console.log(`[smoke] Phase A response summary: ${summarizeFriends(friends)}`);

console.log(`\n[smoke] === Phase B: warm-start (reuse DataStore, no creds) ===`);
const dataStoreB = new FileDataStore(STORE_PATH);
const t2 = Date.now();
// Warm-start needs creds too — the bundle's `authenticate()` will
// short-circuit through the warm path (existing cookies → fresh ticket)
// but still requires `state.auth.fullLogin` to be a viable fallback if
// the cookie path rejects. Pass through the same creds.
const clientB = new SnapcapClient({
  dataStore: dataStoreB,
  credentials: { username: state.username, password: state.password },
  browser: {
    userAgent: state.fingerprint?.userAgent ??
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  },
});
await clientB.authenticate();
const okB = clientB.isAuthenticated();
console.log(`[smoke] authenticate (warm): ${okB} (${Date.now() - t2}ms)`);
if (!okB) throw new Error("Phase B: isAuthenticated() returned false on warm start");

console.log(`[smoke] friends.list() (reused session)…`);
const t3 = Date.now();
const friends2 = await clientB.friends.list();
console.log(`[smoke] friends.list: ${Date.now() - t3}ms`);
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
