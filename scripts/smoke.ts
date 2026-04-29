/**
 * Smoke test for SnapcapClient.
 *
 * Phase A: fromCredentials → listFriends → toAuthBlob (saved to /tmp).
 * Phase B: fromAuth(saved blob) → listFriends again.
 *
 * Phase A asserts the full native login + bearer mint + API call works.
 * Phase B asserts the auth blob is reusable across processes (for the
 * persistence story).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";

const SDK_STATE_PATH = process.env.SNAP_STATE_FILE ??
  join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  username: string;
  password: string;
  fingerprint?: { userAgent: string };
};
const BLOB_PATH = "/tmp/snapcap-smoke-auth.json";

console.log(`[smoke] === Phase A: fromCredentials ===`);
const t0 = Date.now();
const clientA = await SnapcapClient.fromCredentials({
  credentials: { username: state.username, password: state.password },
  userAgent: state.fingerprint?.userAgent,
});
console.log(`[smoke] login + bearer mint: ${Date.now() - t0}ms`);

console.log(`[smoke] listFriends()…`);
const t1 = Date.now();
const friends = await clientA.listFriends();
console.log(`[smoke] listFriends: ${Date.now() - t1}ms`);
const summary = summarizeFriends(friends);
console.log(`[smoke] Phase A response summary: ${summary}`);

console.log(`[smoke] saving auth blob to ${BLOB_PATH}…`);
const blob = await clientA.toAuthBlob();
writeFileSync(BLOB_PATH, JSON.stringify(blob, null, 2));
console.log(`[smoke] saved ${(JSON.stringify(blob).length / 1024).toFixed(1)} KB`);

console.log(`\n[smoke] === Phase B: fromAuth (reuse blob) ===`);
const blobReloaded = JSON.parse(readFileSync(BLOB_PATH, "utf8")) as SnapcapAuthBlob;
const t2 = Date.now();
const clientB = await SnapcapClient.fromAuth({ auth: blobReloaded });
console.log(`[smoke] fromAuth: ${Date.now() - t2}ms`);

console.log(`[smoke] listFriends() (reused session)…`);
const t3 = Date.now();
const friends2 = await clientB.listFriends();
console.log(`[smoke] listFriends: ${Date.now() - t3}ms`);
console.log(`[smoke] Phase B response summary: ${summarizeFriends(friends2)}`);

console.log(`\n[smoke] 🎉 SDK working end-to-end`);
process.exit(0);

function summarizeFriends(r: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
    else if (v && typeof v === "object") parts.push(`${k}{${Object.keys(v).length}}`);
    else if (typeof v === "string") parts.push(`${k}="${v.slice(0, 30)}${v.length > 30 ? "…" : ""}"`);
    else parts.push(`${k}=${v}`);
  }
  return parts.join(", ");
}
