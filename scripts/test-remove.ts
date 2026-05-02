/**
 * Test RemoveFriends with a non-empty `pageSessionId` field — see if
 * server actually severs (vs the silent fake-success on empty body).
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
import { friendActionClient } from "../src/bundle/register.ts";
import { uuidToHighLow } from "../src/api/_helpers.ts";

setLogger((ev: LogEvent) => {
  if (ev.kind !== "net.fetch.done" && ev.kind !== "net.xhr.done") return;
  if (ev.respBytes !== 0) return;
  const seg = ev.url.split("/").pop() ?? "";
  if (/RemoveFriends|SyncFriendData/.test(seg)) {
    console.log(`  [net] ${seg} → ${ev.status} grpc=${ev.grpcStatus ?? "0"} req=${ev.reqBytes}B`);
  }
});

type Account = { username: string; password: string; authPath: string; status?: string; browser?: BrowserContext };
type Smoke = { accounts: Account[]; fingerprint?: { userAgent: string } };

const root = join(import.meta.dir, "..");
const smoke = JSON.parse(readFileSync(join(root, ".snapcap-smoke.json"), "utf8")) as Smoke;
const acct = smoke.accounts.find(a => a.username === "perdyjamie")!;
const targetUserId = "f0480a66-58cb-4869-a928-4c4ea961dd78";  // jamielillee

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(root, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? { userAgent: smoke.fingerprint?.userAgent ?? "Mozilla/5.0" },
});

console.log(`[test-remove] auth as ${acct.username}…`);
await client.authenticate();
await client.friends.refresh();

const before = await client.friends.list();
const seesBefore = before.some(f => f.userId === targetUserId);
console.log(`  pre: perdyjamie sees jamielillee? ${seesBefore ? "yes" : "no — abort"}`);
if (!seesBefore) process.exit(1);

// Get sandbox via internal access — we expose it implicitly through friends manager,
// but the cleanest path is to reach into the friends manager's _getCtx.
const ctx = await (client.friends as any)._getCtx();
const jzClient = friendActionClient(ctx.sandbox);

// Extract the real `sc-a-nonce` cookie value from the auth file — that's
// snap's session correlation id, set during login. UUID-format. Likely
// what the server expects as `pageSessionId`.
const ds = new FileDataStore(join(root, acct.authPath));
const jarBytes = await ds.get("cookie_jar");
const jarStr = jarBytes ? new TextDecoder().decode(jarBytes) : "{}";
const jar = JSON.parse(jarStr) as { cookies: Array<{ key: string; value: string }> };
const nonce = jar.cookies.find(c => c.key === "sc-a-nonce")?.value;
if (!nonce) {
  console.log("  ✗ no sc-a-nonce in cookie jar — abort");
  process.exit(1);
}
console.log(`  using sc-a-nonce as pageSessionId: ${nonce.slice(0, 8)}…`);

// Build request: { params: [{ friendId: Uuid64Pair }], pageSessionId: <real session id> }
const { high, low } = uuidToHighLow(targetUserId);
const req = {
  params: [{ friendId: { highBits: String(high), lowBits: String(low) } }],
  pageSessionId: nonce,
};
console.log(`\n[test-remove] direct RemoveFriends with pageSessionId=${nonce.slice(0,8)}…`);
try {
  const resp = await (jzClient as any).RemoveFriends(req);
  console.log(`  ✓ returned`, JSON.stringify(resp).slice(0, 300));
} catch (err) {
  console.log(`  ✗ threw: ${(err as Error).message}`);
}

await new Promise(r => setTimeout(r, 1500));
await client.friends.refresh();
const after = await client.friends.list();
const seesAfter = after.some(f => f.userId === targetUserId);
console.log(`\n  post: perdyjamie sees jamielillee? ${seesAfter ? "✗ STILL MUTUAL" : "✓ SEVERED"}`);
process.exit(seesAfter ? 1 : 0);
