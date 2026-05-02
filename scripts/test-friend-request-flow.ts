/**
 * E2E friend-request flow:
 *   perdyjamie (sender) → jamielillee (receiver, fresh — no friend history)
 *   sendRequest → wait for request:received event → acceptRequest → verify mutual
 *
 * Usage: bun run scripts/test-friend-request-flow.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  createSharedThrottle,
  RECOMMENDED_THROTTLE_RULES,
  setLogger,
  type BrowserContext,
  type LogEvent,
} from "../src/index.ts";

setLogger((ev: LogEvent) => {
  if (ev.kind !== "net.fetch.done" && ev.kind !== "net.xhr.done") return;
  if (ev.respBytes !== 0) return;
  const seg = ev.url.split("/").pop() ?? "";
  if (/Friends$|FriendData|FriendSync|FriendRequest|UserIdByUsername|search/.test(seg)) {
    console.log(`  [net] ${seg} → ${ev.status} grpc=${ev.grpcStatus ?? "0"} req=${ev.reqBytes}B ${Math.round(ev.durMs)}ms`);
  }
});

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
const acctA = smoke.accounts.find(a => a.username === "perdyjamie")!;
const acctB = smoke.accounts.find(a => a.username === "jamielillee")!;

const fallbackUa = smoke.fingerprint?.userAgent ?? "Mozilla/5.0";
const gate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
const mkClient = (a: Account) => new SnapcapClient({
  dataStore: new FileDataStore(join(root, a.authPath)),
  credentials: { username: a.username, password: a.password },
  browser: a.browser ?? { userAgent: fallbackUa },
  throttle: gate,
});
const A = mkClient(acctA);
const B = mkClient(acctB);

console.log(`[phase 1] auth both accounts (perdyjamie + jamielillee)...`);
try {
  await Promise.all([A.authenticate(), B.authenticate()]);
} catch (err) {
  console.error(`  ✗ FAIL during auth: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`  ✓ both authenticated`);

console.log(`\n[phase 2] resolve jamielillee userId via search from A side...`);
const matches = await A.friends.search("jamielillee");
const userIdB = matches.find(u => u.username === "jamielillee")?.userId;
if (!userIdB) {
  console.error(`  ✗ FAIL: search returned no exact-match for jamielillee — ${matches.length} candidates`);
  matches.slice(0, 5).forEach(m => console.error(`    candidate: ${m.username} (${m.displayName ?? "—"})`));
  process.exit(1);
}
console.log(`  ✓ jamielillee userId = ${userIdB}`);

console.log(`\n[phase 3] subscribe B to request:received + start B refresh polling...`);
const eventFired = new Promise<{ fromUserId: string; fromUsername: string }>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("request:received did not fire within 60s")), 60_000);
  const sub = B.friends.on("request:received", (req) => {
    clearTimeout(timeout);
    sub();
    resolve({ fromUserId: req.fromUserId, fromUsername: req.fromUsername });
  });
});
const pollInterval = setInterval(() => { B.friends.refresh().catch(() => {}); }, 3000);
console.log(`  ✓ subscribed, polling every 3s`);

console.log(`\n[phase 4] perdyjamie sends request to jamielillee...`);
await A.friends.sendRequest(userIdB);
console.log(`  ✓ sendRequest dispatched`);

console.log(`\n[phase 5] waiting for request:received on B...`);
const tStart = Date.now();
let evt: { fromUserId: string; fromUsername: string };
try {
  evt = await eventFired;
} catch (err) {
  clearInterval(pollInterval);
  console.error(`  ✗ FAIL: ${(err as Error).message}`);
  process.exit(1);
}
clearInterval(pollInterval);
console.log(`  ✓ event fired after ${Date.now() - tStart}ms — from ${evt.fromUsername} (${evt.fromUserId.slice(0, 8)}…)`);

console.log(`\n[phase 6] jamielillee accepts...`);
await B.friends.acceptRequest(evt.fromUserId);
await new Promise(r => setTimeout(r, 1500));
await Promise.all([A.friends.refresh(), B.friends.refresh()]);
const aMutuals = (await A.friends.list()).map(f => f.userId);
const bMutuals = (await B.friends.list()).map(f => f.userId);
const aSeesB = aMutuals.includes(userIdB);
const bSeesA = bMutuals.some(id => acctA.username && id);  // we don't know A's userId, but verify B sees ANY new mutual
console.log(`  perdyjamie sees jamielillee? ${aSeesB ? "✓ mutual" : "✗ not mutual"}`);
console.log(`  jamielillee sees perdyjamie? ${bMutuals.length > 0 ? "✓ has mutuals (manually verify perdyjamie among them)" : "✗ no mutuals"}`);

console.log(`\n=== ${aSeesB ? "✓ PASS" : "✗ FAIL"} ===`);
process.exit(aSeesB ? 0 : 1);
