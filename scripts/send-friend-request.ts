/**
 * Send a friend request from jamie_qtsmith → jamie_nichols.
 * Verifies the dweb_add_friend page-field fix end-to-end against a fresh recipient.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";

const TARGET_USERNAME = process.argv[2] ?? "jamie_nichols";
const SENDER_USERNAME = process.argv[3] ?? "jamie_qtsmith";

const SDK_STATE_PATH = join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  accounts: Array<{ username: string; password: string; authPath: string; status: string }>;
  fingerprint?: { userAgent: string };
};

const sender = state.accounts.find((a) => a.username === SENDER_USERNAME);
if (!sender) throw new Error(`${SENDER_USERNAME} not in .snapcap-smoke.json`);

const STORE_PATH = join(import.meta.dir, "..", sender.authPath);
console.log(`[friend-req] sender=${sender.username} target=${TARGET_USERNAME} store=${STORE_PATH}`);

const t0 = Date.now();
const client = new SnapcapClient({
  dataStore: new FileDataStore(STORE_PATH),
  username: sender.username,
  password: sender.password,
  userAgent: state.fingerprint?.userAgent,
});
await client.authenticate();
console.log(`[friend-req] authenticated in ${Date.now() - t0}ms`);

console.log(`[friend-req] searching for ${TARGET_USERNAME}…`);
const t1 = Date.now();
const results = await client.friends.search(TARGET_USERNAME);
console.log(`[friend-req] search returned in ${Date.now() - t1}ms`);
console.log(`[friend-req] raw search:`, JSON.stringify(results, null, 2).slice(0, 600));

const target =
  Array.isArray(results) ? results.find((r: any) => r.username === TARGET_USERNAME) :
  (results as any)?.users?.find?.((r: any) => r.username === TARGET_USERNAME) ??
  (results as any)?.results?.find?.((r: any) => r.username === TARGET_USERNAME);

if (!target) {
  console.error(`[friend-req] no exact match for ${TARGET_USERNAME} in search results`);
  process.exit(1);
}

const targetId = target.userId ?? target.id ?? target.user_id;
console.log(`[friend-req] target found: username=${target.username} userId=${targetId} display=${target.displayName ?? target.display_name ?? "?"}`);

console.log(`[friend-req] calling friends.sendRequest(${targetId})…`);
const t2 = Date.now();
await client.friends.sendRequest(targetId);
console.log(`[friend-req] friends.sendRequest returned in ${Date.now() - t2}ms`);
console.log(`[friend-req] DONE — check ${TARGET_USERNAME}'s "Added Me" panel`);
process.exit(0);
