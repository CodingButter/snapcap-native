/**
 * Extract Jamie's Fidelius device public keys from the SyncFriendData
 * response. The bundle's parser shows each friend record carries a
 * `fideliusFriendInfo: [{publicKey: 65B, version: int}, ...]` array.
 */
import { readFileSync } from "node:fs";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";
import { syncFriendDataRaw } from "../src/api/friends.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const client = await SnapcapClient.fromAuth({ auth: blob });
log(`auth restored as ${client.self?.username}`);

const raw = await syncFriendDataRaw(client.rpc as never);
log(`got SyncFriendData record`);

// Walk the response looking for any object with fideliusFriendInfo.
type FriendKeys = { friendUserId: string; friendUsername?: string; devices: Array<{ publicKey: Uint8Array; version: number }> };
const found: FriendKeys[] = [];

function toBytes(x: unknown): Uint8Array | null {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  if (x && typeof x === "object") {
    const vals = Object.values(x as Record<string, unknown>);
    if (vals.every((v) => typeof v === "number")) return new Uint8Array(vals as number[]);
  }
  return null;
}

function uuidStringify(x: unknown): string | undefined {
  const b = toBytes(x);
  if (!b || b.byteLength !== 16) return undefined;
  const h = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

const stack: Array<{ node: unknown; ctx: Record<string, unknown> | null }> = [{ node: raw, ctx: null }];
const seen = new WeakSet<object>();
while (stack.length) {
  const { node, ctx } = stack.pop()!;
  if (!node || typeof node !== "object") continue;
  if (seen.has(node as object)) continue;
  seen.add(node as object);
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.fideliusFriendInfo) && obj.fideliusFriendInfo.length > 0) {
    const friendUserId = ctx?.userId
      ? uuidStringify((ctx.userId as Record<string, unknown>).id) ?? "?"
      : (uuidStringify((obj.userId as Record<string, unknown> | undefined)?.id) ?? "?");
    const friendUsername = (typeof ctx?.mutableUsername === "string" ? ctx.mutableUsername : undefined)
      ?? (typeof obj.mutableUsername === "string" ? obj.mutableUsername : undefined);
    const devices: FriendKeys["devices"] = [];
    for (const dev of obj.fideliusFriendInfo) {
      if (!dev || typeof dev !== "object") continue;
      const d = dev as Record<string, unknown>;
      const pk = toBytes(d.publicKey);
      if (!pk) continue;
      const ver = typeof d.version === "number" ? d.version
        : typeof d.version === "bigint" ? Number(d.version)
        : typeof d.version === "string" ? parseInt(d.version, 10)
        : 0;
      devices.push({ publicKey: pk, version: ver });
    }
    if (devices.length) found.push({ friendUserId, friendUsername, devices });
  }

  // Recurse, providing parent obj as context for nested records.
  for (const k of Object.keys(obj)) stack.push({ node: obj[k], ctx: obj });
}

log(`\nfound ${found.length} friends with Fidelius keys:`);
for (const f of found) {
  log(`  ${f.friendUsername ?? "?"} (${f.friendUserId.slice(0, 8)}…) — ${f.devices.length} devices`);
  for (const d of f.devices) {
    log(`    v${d.version} pub=${Buffer.from(d.publicKey).toString("hex").slice(0, 20)}…(${d.publicKey.byteLength}B)`);
  }
}

process.exit(0);
