/**
 * Friend list / social graph reads.
 *
 * AtlasGw is the chat-bundle gRPC client at module 74052. We don't import
 * it statically because it lives in the chat bundle (cf-st.sc-cdn.net),
 * not the accounts bundle that bootKameleon loads. The first time
 * something asks for it we lazy-load the chat bundle and merge its
 * factories into the same webpack require.
 */
import { getKameleon } from "../auth/kameleon.ts";
import { ensureChatBundle } from "../auth/chat-bundle.ts";
import { getSandbox } from "../shims/runtime.ts";
import { User } from "./user.ts";

/**
 * AtlasGw client constructor — pulled out of chat bundle module 74052.
 * Cached after first lookup since the class binding is stable per process.
 */
let cachedAtlasClass: (new (rpc: unknown) => Record<string, Function>) | null = null;
function atlasGwClass(): new (rpc: unknown) => Record<string, Function> {
  if (cachedAtlasClass) return cachedAtlasClass;
  ensureChatBundle();
  const wreq = getSandbox().getGlobal<{ (id: string): unknown }>("__snapcap_p");
  if (!wreq) throw new Error("chat-bundle webpack runtime not loaded — call ensureChatBundle first");
  const exp = wreq("74052") as Record<string, unknown>;
  for (const k of Object.keys(exp)) {
    const v = exp[k];
    if (typeof v !== "function") continue;
    const proto = (v as { prototype?: Record<string, unknown> }).prototype;
    if (proto && typeof proto.SyncFriendData === "function") {
      cachedAtlasClass = v as new (rpc: unknown) => Record<string, Function>;
      return cachedAtlasClass;
    }
  }
  throw new Error("AtlasGw class not found in module 74052");
}

export type RpcUnaryFn = (
  method: { methodName: string; service: { serviceName: string }; requestType: { serializeBinary: (this: unknown) => Uint8Array }; responseType: { decode: (b: Uint8Array) => unknown } },
  request: unknown,
  metadata?: unknown,
) => Promise<unknown>;

/**
 * Raw protobuf-decoded SyncFriendData response. Useful when you need
 * the full record (best-friends, fidelius info, story sync state, …)
 * rather than just the friend list. Most callers want `listFriends`.
 */
export type RawSyncFriendData = Record<string, unknown>;

export async function syncFriendDataRaw(rpc: { unary: RpcUnaryFn }): Promise<RawSyncFriendData> {
  await getKameleon();
  const Atlas = atlasGwClass();
  const client = new Atlas(rpc);
  return (await (client.SyncFriendData as Function).call(client, {
    outgoingSyncRequest: { requestType: { $case: "all", all: {} } },
  })) as RawSyncFriendData;
}

/**
 * Walk a SyncFriendData response and produce a flat User[] of the friends
 * (excluding the logged-in user's own self-record). The same response
 * embeds self info; use `findSelf()` from client.ts to extract it.
 */
export async function listFriends(
  rpc: { unary: RpcUnaryFn },
  excludeUserId?: string,
): Promise<User[]> {
  const raw = await syncFriendDataRaw(rpc);
  const users = new Map<string, User>();
  walkForUsers(raw, users);
  if (excludeUserId) users.delete(excludeUserId);
  return Array.from(users.values());
}

function walkForUsers(node: unknown, out: Map<string, User>): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // Friend records have userId + mutableUsername; treat any object with
  // both as a candidate and parse via the User factory.
  if (obj.userId && typeof obj.userId === "object" && obj.mutableUsername) {
    const u = User.fromFriendRecord(obj);
    if (u) {
      out.set(u.userId, u);
      return; // don't recurse into the parsed record
    }
  }
  if (Array.isArray(node)) for (const x of node) walkForUsers(x, out);
  else for (const k of Object.keys(obj)) walkForUsers(obj[k], out);
}
