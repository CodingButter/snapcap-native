/**
 * Verify chat WASM boot triggers bundle's auto-init for Fidelius identity.
 *
 * Authenticates one account, then dumps the resulting auth file's top-level
 * keys. Pass criteria: Fidelius-shaped keys appear (`indexdb_snapcap__fidelius__identity`,
 * `indexdb_snapcap__fidelius__*`, or anything matching `fidelius` / `e2ee`
 * / `messaging`).
 *
 * Usage: bun run scripts/test-wasm-boot.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  setLogger,
  defaultTextLogger,
  type BrowserContext,
} from "../src/index.ts";

setLogger(defaultTextLogger);

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
const acct = smoke.accounts.find(a => a.username === "perdyjamie")!;

console.log(`[wasm-boot] auth as ${acct.username}…`);
const client = new SnapcapClient({
  dataStore: new FileDataStore(join(root, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? { userAgent: smoke.fingerprint?.userAgent ?? "Mozilla/5.0" },
});

await client.authenticate();
console.log(`\n[wasm-boot] auth complete. Inspecting auth file...`);

await new Promise(r => setTimeout(r, 2000)); // give bundle a moment to write back

const authPath = join(root, acct.authPath);
const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
const keys = Object.keys(data).sort();

console.log(`\n[wasm-boot] === ALL TOP-LEVEL KEYS (${keys.length}) ===`);
keys.forEach(k => console.log(`  ${k}`));

const fidKeys = keys.filter(k => /fidelius|e2ee|messaging|identity/i.test(k));
console.log(`\n[wasm-boot] === FIDELIUS-RELATED KEYS (${fidKeys.length}) ===`);
if (fidKeys.length === 0) {
  console.log(`  ✗ none — bundle did NOT auto-init Fidelius identity after WASM boot`);
} else {
  fidKeys.forEach(k => console.log(`  ✓ ${k}`));
}

console.log(`\n=== ${fidKeys.length > 0 ? "✓ HYPOTHESIS CONFIRMED" : "✗ HYPOTHESIS REJECTED — needs additional trigger"} ===`);
process.exit(fidKeys.length > 0 ? 0 : 1);
