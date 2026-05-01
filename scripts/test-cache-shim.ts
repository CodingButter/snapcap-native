/**
 * Smoke test for the Cache Storage API shim.
 *
 * Phase A: install shims with a fresh DataStore, exercise put/match.
 * Phase B: tear down + re-install pointing at the same DataStore file —
 *          confirm the entry survives a sandbox restart (i.e. proves
 *          DataStore-backed persistence is real, not in-memory only).
 */
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FileDataStore } from "../src/storage/data-store.ts";
import { installShims, uninstallShims, getSandbox } from "../src/shims/runtime.ts";

const STORE_PATH = join(import.meta.dir, "..", ".tmp", "auth", "test-cache.json");
if (existsSync(STORE_PATH)) rmSync(STORE_PATH);

async function main(): Promise<void> {
  console.log(`[test-cache] === Phase A: cold install + write/read ===`);
  const dsA = new FileDataStore(STORE_PATH);
  installShims({ dataStore: dsA });
  const sbA = getSandbox();
  const cachesA = sbA.window.caches as {
    open: (n: string) => Promise<{
      put: (req: unknown, res: unknown) => Promise<void>;
      match: (req: unknown) => Promise<Response | undefined>;
      keys: () => Promise<Request[]>;
      delete: (req: unknown) => Promise<boolean>;
    }>;
    has: (n: string) => Promise<boolean>;
    keys: () => Promise<string[]>;
    delete: (n: string) => Promise<boolean>;
    match: (req: unknown) => Promise<Response | undefined>;
  };

  // Sandbox-realm Request/Response — bundle code constructs these.
  const VmRequest = sbA.runInContext("Request") as typeof Request;
  const VmResponse = sbA.runInContext("Response") as typeof Response;

  const cache = await cachesA.open("test-cache");
  await cache.put(
    new VmRequest("https://example.com/x"),
    new VmResponse("hello world", { status: 200, statusText: "OK" }),
  );
  const r = await cache.match("https://example.com/x");
  if (!r) throw new Error("Phase A: match returned undefined");
  const text = await r.text();
  console.log(`[test-cache] read back: "${text}" status: ${r.status}`);
  if (text !== "hello world") throw new Error(`Phase A: body mismatch (got "${text}")`);
  if (r.status !== 200) throw new Error(`Phase A: status mismatch (got ${r.status})`);

  // Exercise the rest of the API surface inline so we know they work.
  const names = await cachesA.keys();
  console.log(`[test-cache] caches.keys(): ${JSON.stringify(names)}`);
  if (!names.includes("test-cache")) throw new Error("Phase A: caches.keys missing entry");
  const has = await cachesA.has("test-cache");
  if (!has) throw new Error("Phase A: caches.has returned false");
  const reqs = await cache.keys();
  console.log(`[test-cache] cache.keys(): [${reqs.map((r) => `${r.method} ${r.url}`).join(", ")}]`);
  if (reqs.length !== 1) throw new Error(`Phase A: expected 1 entry, got ${reqs.length}`);

  // Cross-cache match via caches.match.
  const cross = await cachesA.match("https://example.com/x");
  if (!cross) throw new Error("Phase A: cross-cache match miss");
  console.log(`[test-cache] caches.match cross-search: status=${cross.status}`);

  console.log(`\n[test-cache] === Phase B: re-install, prove persistence ===`);
  await uninstallShims();
  const dsB = new FileDataStore(STORE_PATH);
  installShims({ dataStore: dsB });
  const sbB = getSandbox();
  const cachesB = sbB.window.caches as typeof cachesA;
  const cache2 = await cachesB.open("test-cache");
  const r2 = await cache2.match("https://example.com/x");
  if (!r2) throw new Error("Phase B: match returned undefined after re-install");
  const text2 = await r2.text();
  console.log(`[test-cache] after restart: "${text2}" status: ${r2.status}`);
  if (text2 !== "hello world") throw new Error(`Phase B: body mismatch (got "${text2}")`);

  // Cross-realm sanity: the response we got back should be a sandbox-realm
  // Response (so bundle code that does `instanceof Response` inside the vm
  // realm passes the check).
  const VmResponseB = sbB.runInContext("Response") as typeof Response;
  if (!(r2 instanceof VmResponseB)) {
    throw new Error("Phase B: response is NOT a sandbox-realm Response — instanceof would fail in bundle code");
  }
  console.log(`[test-cache] cross-realm: response is sandbox-realm Response (instanceof passes)`);

  // Delete + verify gone.
  const deleted = await cache2.delete("https://example.com/x");
  if (!deleted) throw new Error("Phase B: delete returned false");
  const after = await cache2.match("https://example.com/x");
  if (after) throw new Error("Phase B: entry still present after delete");
  console.log(`[test-cache] delete: ok (entry gone)`);

  console.log(`\n[test-cache] All checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[test-cache] FAILED: ${err.stack ?? err.message}`);
    process.exit(1);
  },
);
