/**
 * probe-convmgr.ts — introspect the bundle's convMgr methods at runtime.
 *
 * Boots the bundle session for `perdyjamie`, captures the session via
 * onSession, then prints every method on the convMgr (and a couple of
 * key candidates' .toString() so we can see Embind signatures).
 *
 * Run with: bun run scripts/probe-convmgr.ts 2>&1 | tail -200
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore } from "../src/index.ts";

const SDK_ROOT = join(import.meta.dir, "..");
const log = (l: string): void => process.stderr.write(l + "\n");

process.on("unhandledRejection", (e) => log(`[uR] ${(e as Error)?.message}`));
process.on("uncaughtException", (e) => {
  const m = (e as Error)?.message ?? "";
  if (m.includes("setAttribute") || m.includes("not an object")) return;
  log(`[uE] ${m}`);
});

const smoke = JSON.parse(
  readFileSync(join(SDK_ROOT, ".snapcap-smoke.json"), "utf8"),
) as { accounts: { username: string; password: string; authPath?: string; browser?: { userAgent: string } }[]; fingerprint?: { userAgent: string } };
const acct = smoke.accounts.find((a) => a.username === "perdyjamie");
if (!acct) throw new Error("no perdyjamie in smoke");

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, acct.authPath ?? `.tmp/auth/${acct.username}.json`)),
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? { userAgent: smoke.fingerprint?.userAgent ?? "Mozilla/5.0" },
});
await client.authenticate();

// Hook the messaging session and dump convMgr method names.
const noopSub = client.messaging.on("message", () => {});

// Wait for bring-up. setTyping awaits #ensureSession.
await client.messaging.setTyping("00000000-0000-0000-0000-000000000000", 0).catch(() => {});

// Reach into the private `#session` via Bun's introspection — touch via
// any path that has session reference. The Messaging class exposes the
// session via `onSession`. We need to set one before bring-up… simpler:
// subscribe via the bundle's getStandaloneChatRealm + replay the steps.
//
// Easier: reach into Messaging via a downcast.
const m = client.messaging as unknown as {
  ["#session"]?: Record<string, Function>;
  _sess?: unknown;
};
// Bun doesn't expose private fields by name. Use the `realm` we can
// reach via friends._getCtx and walk from there.

const ctx = await (client.friends as unknown as {
  _getCtx: () => Promise<{ sandbox: { getGlobal: (k: string) => unknown } }>;
})._getCtx();

const sandbox = ctx.sandbox;
const _en = sandbox.getGlobal("__SNAPCAP_EN");
log(`[probe] __SNAPCAP_EN type=${typeof _en}`);

// Dump convMgr — we can fish it by re-creating the session via En, but
// we already have one. Try walking up to find it. Simpler: log from inside
// the messaging delegate hook by patching the chunk patcher.
//
// Cleanest: print the keys of the messaging_Session.create return.
// We'll add a temporary log inside fidelius-decrypt to print convMgr keys.
//
// But for now let's at least see if En has a session reference.
log(`[probe] keys on En (if any): ${_en ? Object.keys(_en as object).slice(0, 80).join(", ") : "none"}`);

// Wait then bail
await new Promise((r) => setTimeout(r, 2000));
noopSub();
process.exit(0);
