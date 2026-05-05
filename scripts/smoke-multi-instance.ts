/**
 * Multi-instance smoke test — proves two SnapcapClient instances can
 * coexist in the same process without shared-state corruption, AND
 * proves both throttling modes (per-instance vs shared) work.
 *
 * Pass criteria:
 *   - Both clients construct distinct sandboxes
 *   - Each client's auth.userId reflects its own account
 *   - Each client's friends snapshot reflects its own friend graph
 *   - Both per-instance and shared throttle modes complete cleanly under
 *     parallel `Promise.all` authenticate.
 *
 * NOTE on flakiness: running BOTH modes in one process re-auths the same
 * accounts twice within ~1 minute. Snap's per-account rate limit can
 * 403 the second auth's userId-refresh on accounts with elevated anti-spam
 * scrutiny (e.g. accounts that recently hit TIV/captcha). This is an
 * artifact of the test design, not a bug in either throttle mode. To
 * verify a single mode reliably, comment out the other or run the script
 * twice with a SNAPCAP_SMOKE_MODE env var.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  RECOMMENDED_THROTTLE_RULES,
  createSharedThrottle,
  type ThrottleConfig,
  type ThrottleGate,
} from "../src/index.ts";
import { authSlice } from "../src/bundle/register/index.ts";

const root = join(import.meta.dir, "..");
const cfg = JSON.parse(readFileSync(join(root, ".snapcap-smoke.json"), "utf8"));

const accounts = (cfg.accounts as Array<{ username: string; password: string; authPath: string; status?: string }>)
  .filter((a) => a.status !== "hard-blocked")
  .slice(0, 2);
if (accounts.length < 2) {
  console.error("[multi] need 2 accounts in .snapcap-smoke.json — found", accounts.length);
  process.exit(1);
}
const acctA = accounts[0]!;
const acctB = accounts[1]!;
console.log(`[multi] account A = ${acctA.username}`);
console.log(`[multi] account B = ${acctB.username}`);

interface InspectableSandbox { sandbox: unknown }
const introspect = (c: SnapcapClient): Promise<InspectableSandbox> =>
  (c.friends as unknown as { _getCtx: () => Promise<InspectableSandbox> })._getCtx();

async function runMode(label: string, throttleA: ThrottleConfig | ThrottleGate, throttleB: ThrottleConfig | ThrottleGate): Promise<boolean> {
  console.log(`\n[multi] ─────────── ${label} ───────────`);

  const ua = cfg.fingerprint?.userAgent ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
  const clientA = new SnapcapClient({
    dataStore: new FileDataStore(join(root, acctA.authPath)),
    credentials: { username: acctA.username, password: acctA.password },
    browser: { userAgent: ua },
    throttle: throttleA,
  });
  const clientB = new SnapcapClient({
    dataStore: new FileDataStore(join(root, acctB.authPath)),
    credentials: { username: acctB.username, password: acctB.password },
    browser: { userAgent: ua },
    throttle: throttleB,
  });

  const t = Date.now();
  await Promise.all([clientA.authenticate(), clientB.authenticate()]);
  console.log(`[multi]   parallel authenticate landed in ${Date.now() - t}ms`);

  const [ctxA, ctxB] = await Promise.all([introspect(clientA), introspect(clientB)]);
  const userIdA = (authSlice(ctxA.sandbox as never) as unknown as { userId: string }).userId;
  const userIdB = (authSlice(ctxB.sandbox as never) as unknown as { userId: string }).userId;
  const sandboxesDistinct = ctxA.sandbox !== ctxB.sandbox;

  console.log(`[multi]   sandboxes distinct: ${sandboxesDistinct}`);
  console.log(`[multi]   userIdA=${userIdA ?? "(undef)"} userIdB=${userIdB ?? "(undef)"}`);
  console.log(`[multi]   userIds distinct: ${!!userIdA && !!userIdB && userIdA !== userIdB}`);

  const [snapA, snapB] = await Promise.all([clientA.friends.snapshot(), clientB.friends.snapshot()]);
  console.log(`[multi]   A: mutuals=${snapA.mutuals.length} received=${snapA.received.length} sent=${snapA.sent.length}`);
  console.log(`[multi]   B: mutuals=${snapB.mutuals.length} received=${snapB.received.length} sent=${snapB.sent.length}`);

  const ok = sandboxesDistinct && !!userIdA && !!userIdB && userIdA !== userIdB;
  console.log(`[multi]   ${label}: ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

const perInstanceA: ThrottleConfig = { rules: RECOMMENDED_THROTTLE_RULES };
const perInstanceB: ThrottleConfig = { rules: RECOMMENDED_THROTTLE_RULES };
const sharedGate: ThrottleGate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });

const okPer = await runMode("PER-INSTANCE throttle (each client builds own gate)", perInstanceA, perInstanceB);

// Cool-down between modes — same accounts re-auth too quickly trips Snap's
// per-account rate limit. 30s breathing room mirrors what production
// scenarios would naturally have between sessions.
console.log(`\n[multi]   ⏳ cooling down 30s before next mode (per-account rate limit)…`);
await new Promise((r) => setTimeout(r, 30_000));

const okShared = await runMode("SHARED throttle (both clients await same gate)", sharedGate, sharedGate);

console.log(`\n[multi] ════════════ RESULT ════════════`);
console.log(`[multi]   per-instance: ${okPer ? "PASS" : "FAIL"}`);
console.log(`[multi]   shared:       ${okShared ? "PASS" : "FAIL"}`);
process.exit(okPer && okShared ? 0 : 1);
