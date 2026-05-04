/**
 * test-isolation.ts — proves the standalone Fidelius mint realm is now
 * cached per-Sandbox, not module-global.
 *
 * Two independent `Sandbox` instances each get their own:
 *   - vm.Context (different `realm.context` references)
 *   - moduleEnv (different `realm.moduleEnv` references)
 *   - minted Fidelius identity (different cleartextPublicKey hex)
 *
 * If the mint realm were still cached at module scope (the pre-fix bug),
 * both sandboxes would share the same realm + the same identity, and the
 * second tenant in a multi-tenant runner would silently inherit the first
 * tenant's keys.
 *
 * Usage:
 *   bun run scripts/test-isolation.ts
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import { Sandbox } from "../src/shims/sandbox.ts";
import {
  mintFideliusIdentity,
  getStandaloneChatRealm,
} from "../src/auth/fidelius-mint.ts";

const log = (line: string): void => {
  process.stderr.write(line + "\n");
};

const ua =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

log("[isolation] constructing two independent Sandboxes…");
const sandbox1 = new Sandbox({ userAgent: ua });
const sandbox2 = new Sandbox({ userAgent: ua });

log("[isolation] sandbox1 !== sandbox2 ? " + (sandbox1 !== sandbox2));

log("[isolation] minting identity on sandbox1…");
const id1 = await mintFideliusIdentity(sandbox1);
log("[isolation] minting identity on sandbox2…");
const id2 = await mintFideliusIdentity(sandbox2);

const realm1 = await getStandaloneChatRealm(sandbox1);
const realm2 = await getStandaloneChatRealm(sandbox2);

const hex1 = Buffer.from(id1.cleartextPublicKey).toString("hex");
const hex2 = Buffer.from(id2.cleartextPublicKey).toString("hex");

log(`[isolation] id1 pubkey: ${hex1.slice(0, 32)}…`);
log(`[isolation] id2 pubkey: ${hex2.slice(0, 32)}…`);

const identitiesDiffer = hex1 !== hex2;
const contextsDiffer = realm1.context !== realm2.context;
const moduleEnvsDiffer = realm1.moduleEnv !== realm2.moduleEnv;

// Sanity: a second mint on the SAME sandbox should reuse the cached
// realm — different identity bytes (each call mints fresh) but same
// context/moduleEnv references.
const realm1b = await getStandaloneChatRealm(sandbox1);
const sameSandboxSameContext = realm1.context === realm1b.context;
const sameSandboxSameModuleEnv = realm1.moduleEnv === realm1b.moduleEnv;

log("");
log("[isolation] === results ===");
log(`[isolation]   identities differ across sandboxes: ${identitiesDiffer}`);
log(`[isolation]   vm.Contexts differ across sandboxes: ${contextsDiffer}`);
log(`[isolation]   moduleEnvs differ across sandboxes: ${moduleEnvsDiffer}`);
log(`[isolation]   same sandbox returns same vm.Context (cache works): ${sameSandboxSameContext}`);
log(`[isolation]   same sandbox returns same moduleEnv (cache works): ${sameSandboxSameModuleEnv}`);

const pass =
  identitiesDiffer &&
  contextsDiffer &&
  moduleEnvsDiffer &&
  sameSandboxSameContext &&
  sameSandboxSameModuleEnv;

if (pass) {
  log("[isolation] PASS");
  process.exit(0);
} else {
  log("[isolation] FAIL");
  process.exit(1);
}
