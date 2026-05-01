import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, FileDataStore, RECOMMENDED_THROTTLE_RULES } from "../src/index.ts";
import { authSlice, chatStore } from "../src/bundle/register.ts";

const root = join(import.meta.dir, "..");
const cfg = JSON.parse(readFileSync(join(root, ".snapcap-smoke.json"), "utf8"));
const acct = cfg.accounts.find((a: any) => a.username === "jamie_qtsmith");

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(root, acct.authPath)),
  username: acct.username,
  password: acct.password,
  userAgent: cfg.fingerprint?.userAgent,
  throttle: { rules: RECOMMENDED_THROTTLE_RULES },
});

console.log("[probe] authenticating...");
const t0 = Date.now();
await client.authenticate();
console.log(`[probe] authenticate resolved in ${Date.now()-t0}ms`);
console.log(`[probe] client.isAuthenticated(): ${client.isAuthenticated()}`);

// Pull the sandbox via friends manager's _getCtx (private but accessible)
const ctx = await (client.friends as any)._getCtx();
console.log(`[probe] ctx.sandbox is set: ${typeof ctx.sandbox === "object"}`);

const state = (chatStore(ctx.sandbox).getState() as any);
console.log(`[probe] chatStore keys: ${Object.keys(state).slice(0, 10).join(", ")}`);
console.log(`[probe] state.auth?.authState: ${state.auth?.authState}`);
console.log(`[probe] state.auth?.userId: ${state.auth?.userId}`);
console.log(`[probe] state.auth?.authToken?.token (len): ${state.auth?.authToken?.token?.length ?? "missing"}`);
console.log(`[probe] state.auth?.hasEverLoggedIn: ${state.auth?.hasEverLoggedIn}`);

// Direct authSlice read
const a = authSlice(ctx.sandbox) as any;
console.log(`[probe] authSlice() keys: ${Object.keys(a).slice(0, 12).join(", ")}`);
console.log(`[probe] authSlice().authState: ${a.authState}`);
process.exit(0);
