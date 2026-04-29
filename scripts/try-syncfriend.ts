/**
 * AtlasGw/SyncFriendData diagnostic — direct call without the SDK class.
 *
 * Reads `bearer` and `cookie` from .snapcap-smoke.json (already-issued by a
 * prior login) and POSTs SyncFriendData to web.snapchat.com. Use when:
 *   - You suspect AtlasGw module 74052 has been moved or renamed in the chat
 *     bundle (this script catches that on the require step).
 *   - You want to inspect the raw protobuf response for a method that the
 *     SDK doesn't surface yet.
 *   - You need to verify a captured bearer + cookie pair authenticates,
 *     independently of SnapcapClient's mint/refresh logic.
 *
 * Outcomes:
 *   - 200: pipeline OK; print decoded response keys.
 *   - 401: bearer or cookie missing/expired/invalid (most common after
 *     mint logic regressed — see src/auth/sso.ts).
 *   - require-fail: chat bundle layout shifted; rerun
 *     scripts/load-just-chat.ts to find the new module ID.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../src/shims/runtime.ts";
import { installWebpackCapture } from "../src/shims/webpack-capture.ts";

const SDK_STATE_PATH = process.env.SNAP_STATE_FILE ??
  join(import.meta.dir, "..", ".snapcap-smoke.json");

type SnapState = {
  username: string;
  password: string;
  cookie?: string;
  bearer?: string;
  fingerprint?: { userAgent: string };
};

if (!existsSync(SDK_STATE_PATH)) {
  console.error(`state file not found: ${SDK_STATE_PATH}`);
  process.exit(1);
}
const state: SnapState = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8"));
console.log(`[try] state for: ${state.username}`);
console.log(`  bearer present: ${Boolean(state.bearer)}`);
console.log(`  cookie present: ${Boolean(state.cookie)}`);

installShims({ url: "https://www.snapchat.com/web" });
const { originals } = installWebpackCapture();

const bundleDir = join(import.meta.dir, "..", "vendor", "snap-bundle");
const chatBundlePath = join(
  bundleDir,
  "cf-st.sc-cdn.net",
  "dw",
  "9846a7958a5f0bee7197.js",
);

console.log("[try] loading chat bundle…");
const src = readFileSync(chatBundlePath, "utf8");
new Function("module", "exports", "require", src)(
  { exports: {} },
  {},
  () => {
    throw new Error("require not available");
  },
);
console.log(`[try] loaded; ${originals.size} factories captured`);

// Build a webpack-style require with full runtime helpers.
type ModSlot = { id: string; exports: unknown };
const cache: Record<string, ModSlot> = {};
const allFactories: Record<string, Function> = {};
for (const [stamp, fac] of originals) {
  // stamp is "m<index>#<id>" — extract id
  const id = stamp.split("#")[1] ?? stamp;
  allFactories[id] = fac as Function;
}
console.log(`[try] aggregated ${Object.keys(allFactories).length} factories by id`);

function snapRequire(id: string): unknown {
  if (cache[id]) return cache[id]!.exports;
  const fac = allFactories[id];
  if (!fac) throw new Error(`unknown module: ${id}`);
  const mod: ModSlot = (cache[id] = { id, exports: {} });
  fac.call(mod.exports, mod, mod.exports, snapRequire);
  return mod.exports;
}
const sr = snapRequire as unknown as Record<string, unknown>;
sr.m = allFactories;
sr.c = cache;
sr.g = globalThis;
sr.o = (obj: object, prop: string) =>
  Object.prototype.hasOwnProperty.call(obj, prop);
sr.d = (target: object, defs: Record<string, () => unknown>) => {
  for (const k of Object.keys(defs)) {
    if (!Object.prototype.hasOwnProperty.call(target, k)) {
      Object.defineProperty(target, k, { enumerable: true, get: defs[k] });
    }
  }
};
sr.r = (target: object) => {
  Object.defineProperty(target, "__esModule", { value: true });
};
sr.n = (mod: { __esModule?: boolean; default?: unknown }) => {
  const getter = mod && mod.__esModule ? () => mod.default : () => mod;
  (sr.d as Function)(getter, { a: getter });
  return getter;
};
sr.t = (v: unknown) => v;
sr.e = () => Promise.resolve();
sr.p = "";
sr.a = (
  module: { exports: unknown },
  body: (deps: (a: unknown[]) => unknown[], onDone: () => void) => unknown,
) => {
  try {
    body((d) => d, () => {});
  } catch {
    /* tolerate */
  }
  return module.exports;
};
sr.nmd = (m: { type?: string }) => {
  m.type = "module";
  return m;
};

// Force-load module 74052.
console.log("[try] requiring module 74052 (AtlasGw RPC client)…");
let atlasGwExp: Record<string, unknown>;
try {
  atlasGwExp = snapRequire("74052") as Record<string, unknown>;
} catch (e) {
  console.error("[try] failed to load 74052:", (e as Error).message);
  process.exit(2);
}
console.log(`[try] 74052 export keys: ${Object.keys(atlasGwExp).slice(0, 20).join(", ")}`);

// Find the export that's a class with SyncFriendData on its prototype.
let AtlasClass: (new (rpc: unknown) => Record<string, Function>) | null = null;
let atlasKey: string | null = null;
for (const k of Object.keys(atlasGwExp)) {
  const v = atlasGwExp[k];
  if (typeof v !== "function") continue;
  const proto = (v as { prototype?: Record<string, unknown> }).prototype;
  if (proto && typeof proto.SyncFriendData === "function") {
    AtlasClass = v as new (rpc: unknown) => Record<string, Function>;
    atlasKey = k;
    break;
  }
}
if (!AtlasClass || !atlasKey) {
  console.error("[try] couldn't find AtlasGw class export with SyncFriendData");
  process.exit(2);
}
console.log(`[try] AtlasGw class found at export key "${atlasKey}"`);

// Implement a minimal rpc.unary that POSTs gRPC-Web to web.snapchat.com.
const rpc = {
  unary: async (
    method: any,
    request: unknown,
    _metadata?: unknown,
  ): Promise<unknown> => {
    if (!state.bearer) throw new Error("no bearer in state");
    console.log(`[rpc.unary] method keys: ${Object.keys(method).join(", ")}`);
    console.log(`[rpc.unary] requestType keys: ${method.requestType ? Object.keys(method.requestType).join(", ") : "(none)"}`);
    console.log(`[rpc.unary] service keys: ${method.service ? Object.keys(method.service).join(", ") : "(none)"}`);
    console.log(`[rpc.unary] request shape: ${JSON.stringify(request).slice(0, 300)}`);
    if (method.requestType?.serializeBinary) {
      console.log(`[rpc.unary] serializeBinary src: ${method.requestType.serializeBinary.toString().slice(0, 300)}`);
    }
    const svcName =
      method.service?.serviceName ?? method.service?.name ?? "unknown.Service";
    const url = `https://web.snapchat.com/${svcName}/${method.methodName}`;
    console.log(`[rpc.unary] → POST ${url}`);
    // requestType.serializeBinary is `serializeBinary(){return q.encode(this).finish()}`.
    // Call with `this = request` so q.encode operates on the request object.
    let reqBytes: Uint8Array;
    if (typeof method.requestType?.serializeBinary === "function") {
      reqBytes = method.requestType.serializeBinary.call(request);
    } else if (typeof (request as { serializeBinary?: () => Uint8Array })?.serializeBinary === "function") {
      reqBytes = (request as { serializeBinary: () => Uint8Array }).serializeBinary();
    } else if (typeof method.requestType?.encode === "function") {
      reqBytes = method.requestType.encode(request).finish();
    } else {
      console.log(`[rpc.unary] request raw shape:`, request);
      throw new Error("don't know how to encode request");
    }
    const framed = new Uint8Array(5 + reqBytes.byteLength);
    framed[0] = 0;
    new DataView(framed.buffer).setUint32(1, reqBytes.byteLength, false);
    framed.set(reqBytes, 5);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        authorization: `Bearer ${state.bearer}`,
        referer: "https://www.snapchat.com/",
        "user-agent":
          state.fingerprint?.userAgent ??
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      },
      body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
    });
    const status = resp.status;
    const buf = new Uint8Array(await resp.arrayBuffer());
    console.log(`[rpc.unary] ← ${status} ${buf.byteLength} bytes`);
    if (status !== 200) {
      throw new Error(`HTTP ${status}: ${new TextDecoder().decode(buf).slice(0, 200)}`);
    }
    // Strip 5-byte gRPC-Web frame header before decoding. AtlasGw method
    // descriptors expose responseType.deserializeBinary (older grpc-web
    // style); newer ts-proto modules use responseType.decode. Try both —
    // this is a diagnostic, kept robust against either convention.
    const dataLen = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
    const payload = buf.subarray(5, 5 + dataLen);
    if (typeof method.responseType?.deserializeBinary === "function") {
      return method.responseType.deserializeBinary(payload);
    }
    if (typeof method.responseType?.decode === "function") {
      return method.responseType.decode(payload);
    }
    return payload;
  },
};

console.log("[try] constructing AtlasGw client…");
let client: Record<string, Function>;
try {
  client = new AtlasClass(rpc);
} catch (e) {
  console.error("[try] constructor failed:", (e as Error).message);
  process.exit(2);
}
console.log(
  `[try] client constructed; SyncFriendData type: ${typeof client.SyncFriendData}`,
);

console.log("[try] calling SyncFriendData…");
try {
  const result = await client.SyncFriendData!({
    outgoingSyncRequest: { requestType: { $case: "all", all: {} } },
  });
  console.log("[try] ✓ result:");
  console.log(JSON.stringify(result, null, 2).slice(0, 2000));
} catch (e) {
  console.error(`[try] ✗ ${(e as Error).message?.slice(0, 600)}`);
}

process.exit(0);
