/**
 * Probe whether a given account can actually log in via the SDK.
 * Default target: jamielillee (marked "soft-blocked" in smoke state — verify).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";

const TARGET = process.argv[2] ?? "jamielillee";

const SDK_STATE_PATH = join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  accounts: Array<{ username: string; password: string; authPath: string; status?: string }>;
  fingerprint?: { userAgent: string };
};
const acct = state.accounts.find((a) => a.username === TARGET);
if (!acct) throw new Error(`${TARGET} not in .snapcap-smoke.json`);

const STORE_PATH = join(import.meta.dir, "..", acct.authPath);
console.log(`[probe] target=${acct.username} stored-status=${acct.status ?? "?"} store=${STORE_PATH}`);

const t0 = Date.now();
const client = new SnapcapClient({
  dataStore: new FileDataStore(STORE_PATH),
  username: acct.username,
  password: acct.password,
  userAgent: state.fingerprint?.userAgent,
});

try {
  await client.authenticate();
  const ok = client.isAuthenticated();
  console.log(`[probe] authenticate: ${ok} (${Date.now() - t0}ms)`);
  if (!ok) {
    console.log(`[probe] RESULT: authenticated=false — login flow ran but did not establish a session`);
    process.exit(1);
  }

  console.log(`[probe] running cheap follow-up: friends.search("snapchat")…`);
  const t1 = Date.now();
  const results = await client.friends.search("snapchat");
  console.log(`[probe] search returned ${Array.isArray(results) ? results.length : "?"} results in ${Date.now() - t1}ms`);
  console.log(`[probe] RESULT: ${TARGET} is NOT blocked — login + a real RPC both worked`);
  process.exit(0);
} catch (err) {
  console.log(`[probe] authenticate threw after ${Date.now() - t0}ms`);
  console.log(`[probe] error:`, err);
  console.log(`[probe] RESULT: ${TARGET} authentication failed — could be soft-block, captcha, or creds issue`);
  process.exit(2);
}
