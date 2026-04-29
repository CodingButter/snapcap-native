/**
 * Probe the chat-bundle WASM for crypto primitives we can call directly.
 *
 * Once boot lands, walk the 267 Embind-registered classes for any method
 * named after standard crypto operations. Anything we can call without
 * a full Session unblocks empirical KDF/AAD reversal.
 */
import { mintFideliusIdentity } from "../src/auth/fidelius-mint.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

log("[probe] minting one identity to ensure WASM is booted…");
const id = await mintFideliusIdentity();
log(`[probe] booted. identity: pub=${id.cleartextPublicKey.byteLength}B priv=${id.cleartextPrivateKey.byteLength}B`);

// At this point the WASM Module lives on the cached bootOnce result.
// Re-import to grab moduleEnv via the same boot path.
// Actually — we don't expose Module from the mint module. Let's reach
// into globalThis where webpack's module map lives, then grab the Module
// from the wreq cache for module 86818 (Emscripten factory).
const w = globalThis as unknown as {
  __snapcap_p?: { (id: string): unknown; m: Record<string, Function> };
};
const wreq = w.__snapcap_p;
if (!wreq) throw new Error("no __snapcap_p on globalThis — mint module didn't boot?");

// The factory is wreq("86818").A. Calling it returned a Promise<Module>.
// But we don't have the Module — bootOnce stashed it locally. Easiest fix:
// expose the Module from fidelius-mint via a debug global.
const Module = (globalThis as unknown as { __snapcap_fidelius_module?: Record<string, unknown> }).__snapcap_fidelius_module;
if (!Module) {
  log("[probe] Module not exposed yet — adding a debug hook to fidelius-mint…");
  log("       Re-run after editing src/auth/fidelius-mint.ts to set globalThis.__snapcap_fidelius_module = moduleEnv");
  process.exit(2);
}

const allKeys = Object.keys(Module).sort();
log(`[probe] Module has ${allKeys.length} keys`);

const CRYPTO_RE = /encrypt|decrypt|seal|open|wrap|unwrap|cipher|kdf|hkdf|derive|phi|hmac|sign|verify|secret|shared|hash/i;
log(`\n[probe] sweeping for crypto-named methods…`);
let hits = 0;
for (const name of allKeys) {
  const klass = Module[name] as { prototype?: Record<string, unknown> } | undefined;
  if (typeof klass !== "function") continue;
  const matches: string[] = [];
  for (const k of Object.getOwnPropertyNames(klass)) {
    if (["length", "name", "prototype", "argCount", "constructor"].includes(k)) continue;
    if (CRYPTO_RE.test(k)) matches.push(`static ${k}`);
  }
  if (klass.prototype) {
    for (const k of Object.getOwnPropertyNames(klass.prototype)) {
      if (k === "constructor") continue;
      if (CRYPTO_RE.test(k)) matches.push(k);
    }
  }
  if (matches.length) {
    log(`  ${name}: ${matches.join(", ")}`);
    hits++;
  }
}
log(`[probe] ${hits} classes match crypto regex`);
process.exit(0);
