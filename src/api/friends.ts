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
 * Opaque snapshot of someone's social graph. Shape mirrors what AtlasGw
 * returns; we keep it loose for now since SyncFriendData responds with
 * many nested oneofs and we don't need to surface them all yet.
 */
export type RawSyncFriendData = Record<string, unknown>;

export async function listFriends(rpc: { unary: RpcUnaryFn }): Promise<RawSyncFriendData> {
  await getKameleon();  // ensures accounts bundle + p.m are populated
  const Atlas = atlasGwClass();
  const client = new Atlas(rpc);
  const result = await (client.SyncFriendData as Function).call(client, {
    outgoingSyncRequest: { requestType: { $case: "all", all: {} } },
  });
  return result as RawSyncFriendData;
}
