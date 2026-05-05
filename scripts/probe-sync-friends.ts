/**
 * Inspect what user.syncFriends actually IS at runtime, then call it
 * directly with timing + before/after slice deltas. Goal: figure out
 * why it returns silently and emits no SyncFriendData RPC.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";
import { userSlice } from "../src/bundle/register/index.ts";

const SDK_STATE_PATH = join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8"));
const acct = state.accounts.find((a: any) => a.username === "jamie_qtsmith");

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(import.meta.dir, "..", acct.authPath)),
  username: acct.username,
  password: acct.password,
  userAgent: state.fingerprint?.userAgent,
});
await client.authenticate();
console.log(`[probe] authed as ${acct.username}`);

const u = userSlice();

// 1. What slots exist on the user slice?
console.log(`\n[probe] === SLICE SHAPE ===`);
const keys = Object.keys(u);
console.log(`  keys (${keys.length}):`, keys);

// 2. What slots are functions?
const fns = keys.filter((k) => typeof (u as any)[k] === "function");
console.log(`\n[probe] === FUNCTION SLOTS (${fns.length}) ===`);
for (const k of fns) {
  const fn = (u as any)[k] as Function;
  console.log(`  ${k}: length=${fn.length} name="${fn.name}"`);
}

// 3. What does syncFriends look like?
console.log(`\n[probe] === user.syncFriends ===`);
const sf = (u as any).syncFriends;
console.log(`  typeof: ${typeof sf}`);
if (typeof sf === "function") {
  console.log(`  fn.name: "${sf.name}"`);
  console.log(`  fn.length: ${sf.length}`);
  const src = sf.toString();
  console.log(`  source (${src.length}B):\n${src.slice(0, 1500)}`);
}

// 4. Inspect interesting state fields BEFORE
console.log(`\n[probe] === SLICE STATE (BEFORE) ===`);
const interesting = [
  "mutuallyConfirmedFriendIds",
  "outgoingFriendRequestIds",
  "incomingFriendRequests",
  "publicUsers",
  "friendsLastSyncedAt",
  "lastFriendsSync",
  "isSyncingFriends",
  "syncedFriendsAt",
];
for (const k of interesting) {
  const v = (u as any)[k];
  if (v === undefined) continue;
  if (Array.isArray(v)) console.log(`  ${k}: Array(${v.length})`);
  else if (v instanceof Map) console.log(`  ${k}: Map(${v.size})`);
  else console.log(`  ${k}:`, v);
}

// 5. Call syncFriends with timing
console.log(`\n[probe] === CALLING user.syncFriends() ===`);
const t0 = Date.now();
try {
  const result = await sf.call(u);
  console.log(`  resolved in ${Date.now() - t0}ms`);
  console.log(`  return value:`, result);
} catch (e) {
  console.log(`  THREW after ${Date.now() - t0}ms:`, (e as Error).message);
}

// 6. Re-read slice AFTER
const u2 = userSlice();
console.log(`\n[probe] === SLICE STATE (AFTER) ===`);
for (const k of interesting) {
  const v = (u2 as any)[k];
  if (v === undefined) continue;
  if (Array.isArray(v)) console.log(`  ${k}: Array(${v.length})`);
  else if (v instanceof Map) console.log(`  ${k}: Map(${v.size})`);
  else console.log(`  ${k}:`, v);
}

// 7. Wait 2s and re-read in case it's async dispatch
await new Promise((r) => setTimeout(r, 2000));
const u3 = userSlice();
console.log(`\n[probe] === SLICE STATE (+2s) ===`);
for (const k of interesting) {
  const v = (u3 as any)[k];
  if (v === undefined) continue;
  if (Array.isArray(v)) console.log(`  ${k}: Array(${v.length})`);
  else if (v instanceof Map) console.log(`  ${k}: Map(${v.size})`);
  else console.log(`  ${k}:`, v);
}

process.exit(0);
