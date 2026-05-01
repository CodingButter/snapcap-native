/**
 * Inspect what `ee.Zw(state)` likely gates on. Walk the top-level chat
 * state, dump shape of each slice (sizes / key existence), specifically
 * looking for `wasm.workerProxy`, `auth.authState`, anything else the
 * gate could be reading.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";
import { chatStore } from "../src/bundle/register.ts";

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

const s = chatStore().getState() as any;
console.log(`\n[probe] === TOP-LEVEL CHAT STATE SLICES ===`);
const keys = Object.keys(s);
console.log(`  ${keys.length} slices:`, keys);

const summarize = (label: string, val: any, depth = 0): void => {
  const pad = "  ".repeat(depth);
  if (val === null) { console.log(`${pad}${label}: null`); return; }
  if (val === undefined) { console.log(`${pad}${label}: undefined`); return; }
  if (typeof val === "function") { console.log(`${pad}${label}: function`); return; }
  if (val instanceof Map) { console.log(`${pad}${label}: Map(${val.size})`); return; }
  if (val instanceof Set) { console.log(`${pad}${label}: Set(${val.size})`); return; }
  if (Array.isArray(val)) { console.log(`${pad}${label}: Array(${val.length})`); return; }
  if (typeof val !== "object") { console.log(`${pad}${label}: ${typeof val} = ${JSON.stringify(val)?.slice(0, 100)}`); return; }
  // object — list keys
  const k = Object.keys(val);
  console.log(`${pad}${label}: object{${k.length}}`);
  if (depth >= 2) return;
  for (const kk of k.slice(0, 30)) {
    summarize(kk, val[kk], depth + 1);
  }
};

console.log(`\n[probe] === SLICE SHAPES (depth 2) ===`);
for (const k of keys) summarize(k, s[k]);

// Specifically inspect candidates the precondition could check
console.log(`\n[probe] === LIKELY GATE CANDIDATES ===`);
console.log(`  auth.authState:`, s.auth?.authState);
console.log(`  auth.hasEverLoggedIn:`, s.auth?.hasEverLoggedIn);
console.log(`  auth.authToken?.token (len):`, s.auth?.authToken?.token?.length ?? "missing");
console.log(`  wasm:`, typeof s.wasm, s.wasm ? Object.keys(s.wasm) : "");
console.log(`  wasm.workerProxy:`, typeof s.wasm?.workerProxy);
console.log(`  wasm.session:`, typeof s.wasm?.session);
console.log(`  wasm.isReady:`, s.wasm?.isReady);
console.log(`  user.userId:`, s.user?.userId);
console.log(`  user.username:`, s.user?.username);
console.log(`  user.friendsSyncStatus:`, s.user?.friendsSyncStatus);
console.log(`  network.online:`, s.network?.online);
console.log(`  network.connectivity:`, s.network?.connectivity);

process.exit(0);
