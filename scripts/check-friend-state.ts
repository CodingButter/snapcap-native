/**
 * Check qtsmith's friend state to diagnose:
 *   - did our sendRequest() reach Snap's server? (→ user's accept would mutualize)
 *   - or was it silently dropped? (→ user shows up as pending received only)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";

const SDK_STATE_PATH = join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  accounts: Array<{ username: string; password: string; authPath: string }>;
  fingerprint?: { userAgent: string };
};
const sender = state.accounts.find((a) => a.username === "jamie_qtsmith")!;
const STORE_PATH = join(import.meta.dir, "..", sender.authPath);

const client = new SnapcapClient({
  dataStore: new FileDataStore(STORE_PATH),
  username: sender.username,
  password: sender.password,
  userAgent: state.fingerprint?.userAgent,
});
await client.authenticate();
console.log(`[check] authenticated as ${sender.username}`);

const friends = await client.friends.list();
const received = await client.friends.receivedRequests();
const sent = await client.friends.sentRequests();

const summarize = (label: string, list: any[]) => {
  console.log(`\n[check] ${label}: ${list.length}`);
  for (const f of list) {
    console.log(`  - ${f.username ?? "?"} (${f.userId ?? "?"}) display=${f.displayName ?? "?"}`);
  }
};

summarize("friends.list()", Array.isArray(friends) ? friends : []);
summarize("friends.receivedRequests()", Array.isArray(received) ? received.map((r) => ({ userId: r.fromUserId, username: r.fromUsername, displayName: r.fromDisplayName })) : []);
summarize("friends.sentRequests()", Array.isArray(sent) ? sent.map((r) => ({ userId: r.toUserId, username: r.toUsername, displayName: r.toDisplayName })) : []);

const NICHOLS_ID = "eabd1d89-239a-4f7b-bbcc-0ae3b26c5202";
const inFriends   = friends.find((f) => f.userId === NICHOLS_ID || f.username === "jamie_nichols");
const inReceived  = received.find((r) => r.fromUserId === NICHOLS_ID || r.fromUsername === "jamie_nichols");
const inSent      = sent.find((r) => r.toUserId === NICHOLS_ID || r.toUsername === "jamie_nichols");

console.log(`\n[check] === DIAGNOSIS ===`);
console.log(`  jamie_nichols in friends:   ${!!inFriends}`);
console.log(`  jamie_nichols in received:  ${!!inReceived}`);
console.log(`  jamie_nichols in sent:      ${!!inSent}`);

if (inFriends) {
  console.log(`\n  → MUTUAL. Our SDK sendRequest() reached the server; user's accept turned it into a mutual friend.`);
} else if (inReceived && !inSent) {
  console.log(`\n  → RECEIVED ONLY. Our SDK sendRequest() was dropped (likely soft-block on qtsmith). User's add appears here.`);
} else if (inSent) {
  console.log(`\n  → SENT PENDING. Our sendRequest() was sent; recipient hasn't accepted yet.`);
} else {
  console.log(`\n  → NO RECORD. Either the read-side sync gap (likely) or both sides dropped.`);
  console.log(`     Read-sync gap is known: friends.list() returns empty even when friends exist.`);
}
process.exit(0);
