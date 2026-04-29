/**
 * Friend list / social graph reads.
 *
 * AtlasGw is the chat-bundle gRPC client at module 74052. We don't import
 * it statically because it lives in the chat bundle (cf-st.sc-cdn.net),
 * not the accounts bundle that bootKameleon loads. The first time
 * something asks for it we lazy-load the chat bundle and merge its
 * factories into the same webpack require.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKameleon } from "../auth/kameleon.ts";
import { User } from "./user.ts";

let chatBundleLoaded = false;

function ensureChatBundle(): void {
  if (chatBundleLoaded) return;
  const w = globalThis as unknown as {
    __snapcap_p?: { (id: string): unknown; m: Record<string, Function> };
  };
  if (!w.__snapcap_p) {
    throw new Error("getKameleon() must be called before loading chat bundle");
  }

  const chatPath = join(
    import.meta.dirname,
    "..",
    "..",
    "vendor",
    "snap-bundle",
    "cf-st.sc-cdn.net",
    "dw",
    "9846a7958a5f0bee7197.js",
  );
  const src = readFileSync(chatPath, "utf8");
  new Function("module", "exports", "require", src)(
    { exports: {} }, {}, () => { throw new Error("require not available"); },
  );

  // Chat bundle pushes into `webpackChunk_snapchat_web_calling_app`, a
  // different chunk array than the accounts runtime watches. Manually merge
  // its factories into p.m so wreq() can find them.
  const arr = (globalThis as unknown as Record<string, unknown[]>)["webpackChunk_snapchat_web_calling_app"];
  if (Array.isArray(arr)) {
    for (const chunk of arr) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const mods = chunk[1] as Record<string, Function>;
      if (mods && typeof mods === "object") {
        for (const id in mods) {
          const factory = mods[id];
          if (factory) w.__snapcap_p!.m[id] = factory;
        }
      }
    }
  }
  chatBundleLoaded = true;
}

/**
 * AtlasGw client constructor — pulled out of chat bundle module 74052.
 * Cached after first lookup since the class binding is stable per process.
 */
let cachedAtlasClass: (new (rpc: unknown) => Record<string, Function>) | null = null;
function atlasGwClass(): new (rpc: unknown) => Record<string, Function> {
  if (cachedAtlasClass) return cachedAtlasClass;
  ensureChatBundle();
  const w = globalThis as unknown as { __snapcap_p: { (id: string): unknown } };
  const exp = w.__snapcap_p("74052") as Record<string, unknown>;
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
