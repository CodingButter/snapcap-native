/**
 * Probe: just call state.wasm.initialize() and see what blows up.
 *
 * Tells us whether the bundle's full bring-up path can be invoked, and
 * if not, what specific dependency is missing (likely Worker class,
 * Comlink helpers, or a chunk that wasn't loaded). The error tells us
 * the shim/facade target.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore, type BrowserContext } from "../src/index.ts";
import { chatStore } from "../src/bundle/register.ts";

type Account = { username: string; password: string; authPath: string; status?: string; browser?: BrowserContext };
type Smoke = { accounts: Account[]; fingerprint?: { userAgent: string } };

const root = join(import.meta.dir, "..");
const smoke = JSON.parse(readFileSync(join(root, ".snapcap-smoke.json"), "utf8")) as Smoke;
const acct = smoke.accounts.find(a => a.username === "perdyjamie")!;

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(root, acct.authPath)),
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? { userAgent: smoke.fingerprint?.userAgent ?? "Mozilla/5.0" },
});

console.log(`[wasm-init] auth as ${acct.username}…`);
await client.authenticate();
console.log(`[wasm-init] auth complete. Pulling state.wasm.initialize from store...`);

const ctx = await (client.friends as any)._getCtx();
const store = chatStore(ctx.sandbox);
const state = store.getState() as any;
const initFn = state.wasm?.initialize;
console.log(`[wasm-init] state.wasm.initialize: ${typeof initFn}`);

if (typeof initFn !== "function") {
  console.log(`✗ no initialize function on wasm slice — abort`);
  process.exit(1);
}

// Define an in-sandbox MessageChannel STUB — Node's cross-realm
// MessageChannel hangs auth/eval. Stub satisfies bundle's `serialize`
// shape check; if Comlink actually uses ports for sub-proxies we'll
// see the next failure mode.
ctx.sandbox.runInContext(`
  globalThis.MessageChannel = class MessageChannel {
    constructor() {
      const stub = { postMessage(){}, addEventListener(){}, removeEventListener(){}, start(){}, close(){} };
      this.port1 = stub;
      this.port2 = stub;
    }
  };
  globalThis.MessagePort = class MessagePort {
    postMessage(){} addEventListener(){} removeEventListener(){} start(){} close(){}
  };
`, "in-sandbox-messagechannel-stub");
console.log(`[wasm-init] in-sandbox MessageChannel stub installed`);

console.log(`[wasm-init] calling state.wasm.initialize()...`);
try {
  await initFn();
  console.log(`[wasm-init] ✓ initialize() resolved without throwing`);
} catch (err) {
  const e = err as Error;
  console.log(`[wasm-init] ✗ initialize() threw:`);
  console.log(`  type: ${e.constructor.name}`);
  console.log(`  message: ${e.message}`);
  console.log(`  stack (first 10 lines):`);
  (e.stack ?? "").split("\n").slice(0, 10).forEach(l => console.log(`    ${l}`));
}

console.log(`\n[wasm-init] post-state — wasm slot keys:`);
const post = store.getState() as any;
console.log(`  ${Object.keys(post.wasm ?? {}).join(", ")}`);
console.log(`  module: ${typeof post.wasm?.module}`);
console.log(`  worker: ${typeof post.wasm?.worker}`);
console.log(`  workerProxy: ${typeof post.wasm?.workerProxy}`);

process.exit(0);
