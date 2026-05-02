/**
 * Diagnostic: dump the chat store's slice structure after auth.
 *
 * Tells us:
 *   - What top-level slices exist (wasm, messaging, user, auth, ...)
 *   - For each slice, what keys it has (so we know whether `messaging.initializeClient`
 *     is actually there, what `wasm.*` looks like, etc.)
 *
 * Usage: bun run scripts/test-store-shape.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  type BrowserContext,
} from "../src/index.ts";
import { chatStore } from "../src/bundle/register.ts";

type Account = {
  username: string;
  password: string;
  authPath: string;
  status?: string;
  browser?: BrowserContext;
};
type Smoke = { accounts: Account[]; fingerprint?: { userAgent: string } };

const root = join(import.meta.dir, "..");
const smoke = JSON.parse(readFileSync(join(root, ".snapcap-smoke.json"), "utf8")) as Smoke;
const acct = smoke.accounts.find(a => a.username === "perdyjamie")!;

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(root, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? { userAgent: smoke.fingerprint?.userAgent ?? "Mozilla/5.0" },
});

console.log(`[store-shape] auth as ${acct.username}…`);
await client.authenticate();
console.log(`[store-shape] auth complete. Inspecting store...`);

// Reach into the sandbox via the friends manager's _getCtx (same trick we used before).
const ctx = await (client.friends as any)._getCtx();
const store = chatStore(ctx.sandbox);
const state = store.getState() as Record<string, unknown>;

console.log(`\n[store-shape] === TOP-LEVEL SLICES (${Object.keys(state).length}) ===`);
for (const key of Object.keys(state).sort()) {
  const slice = state[key];
  const sliceType = slice === null ? "null" : typeof slice;
  if (sliceType === "object") {
    const subkeys = Object.keys(slice as object);
    console.log(`  ${key}: object (${subkeys.length} keys)`);
    if (subkeys.length <= 30) {
      for (const sk of subkeys.sort()) {
        const v = (slice as Record<string, unknown>)[sk];
        const vt = v === null ? "null" : typeof v;
        const detail = vt === "function" ? "fn" : vt === "object" && v ? `{${Object.keys(v).slice(0,5).join(",")}}` : String(v).slice(0, 60);
        console.log(`    ${sk}: ${vt} ${detail}`);
      }
    } else {
      console.log(`    (${subkeys.length} keys — truncated)`);
    }
  } else {
    console.log(`  ${key}: ${sliceType} ${String(slice).slice(0, 80)}`);
  }
}

process.exit(0);
