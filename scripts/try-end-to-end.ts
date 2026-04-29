/**
 * End-to-end native flow:
 *   1. Boot kameleon, mint attestation, log in via WebLoginService → cookie.
 *   2. GET /accounts/sso?client_id=web-calling-corp--prod → 303 with
 *      `Location: https://www.snapchat.com/web#ticket=<bearer>`.
 *   3. Hit AtlasGw/SyncFriendData on web.snapchat.com with that bearer.
 *
 * Step 2 is how the browser actually gets the bearer. /web-chat-session/refresh
 * returns 200 with empty body — it's for renewing an existing bearer, not
 * issuing the first one. Issuance happens via SSO redirect fragment.
 *
 * Success criterion: SyncFriendData returns 200 with friend data. Confirms
 * the cookie is real, the bearer is real, and AtlasGw is NOT Fidelius-gated
 * (which we suspected when we got 401 with the Playwright-captured bearer).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import { bootKameleon } from "../src/auth/kameleon.ts";

const SDK_STATE_PATH = process.env.SNAP_STATE_FILE ??
  join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  username: string;
  password: string;
  fingerprint?: { userAgent: string };
};
const userAgent =
  state.fingerprint?.userAgent ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Stash native fetch BEFORE bootKameleon. happy-dom replaces fetch and
// strips Set-Cookie. Same hazard, same fix as try-weblogin.ts.
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const jar = new CookieJar();
async function jarFetch(url: string, init: RequestInit & { redirect?: "follow" | "manual" } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookieHeader = await jar.getCookieString(url);
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
  const resp = await nativeFetch(url, { ...init, headers, redirect: init.redirect ?? "follow" });
  const setCookies =
    (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of setCookies) {
    try { await jar.setCookie(c, url); } catch { /* tolerate */ }
  }
  return resp;
}

console.log(`[e2e] === phase 1: boot kameleon + native login ===`);
await bootKameleon({ page: "www_login" });
const w = globalThis as unknown as {
  __snapcap_p: { (id: string): unknown; m: Record<string, Function> };
};
const wreq = w.__snapcap_p;

const kamCtx = await bootKameleon({ page: "www_login" });
const attestation = await kamCtx.finalize(state.username);
console.log(`[e2e] attestation len=${attestation.length}`);

const protoMod = wreq("29517") as {
  WebLoginRequest: {
    fromPartial: (p: object) => object;
    encode: (msg: object) => { finish: () => Uint8Array };
  };
  WebLoginResponse: {
    decode: (b: Uint8Array) => Record<string, unknown>;
  };
};
const desc = wreq("13150") as {
  WebLoginServiceWebLoginDesc: { methodName: string; service: { serviceName: string } };
};
const url1 = `https://accounts.snapchat.com/${desc.WebLoginServiceWebLoginDesc.service.serviceName}/${desc.WebLoginServiceWebLoginDesc.methodName}`;

// Pass continueParam pointing to /accounts/sso so the server knows where to
// redirect after login (some flows embed a ticket directly in redirectUrl).
const continueParam = "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb";

const headerBrowserBase = {
  authenticationSessionPayload: new Uint8Array(),
  attestationPayload: new TextEncoder().encode(attestation),
  arkoseToken: "",
  ssoClientId: "",
  continueParam,
  multiUser: false,
  captchaPayload: { provider: 0, payload: "", errorMessage: "" },
};

async function postWebLogin(req: object, refererPath: string): Promise<Record<string, unknown>> {
  const partial = protoMod.WebLoginRequest.fromPartial(req);
  const bytes = protoMod.WebLoginRequest.encode(partial).finish();
  const framed = new Uint8Array(5 + bytes.byteLength);
  framed[0] = 0;
  new DataView(framed.buffer).setUint32(1, bytes.byteLength, false);
  framed.set(bytes, 5);
  const resp = await jarFetch(url1, {
    method: "POST",
    headers: {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      referer: `https://accounts.snapchat.com${refererPath}`,
      origin: "https://accounts.snapchat.com",
      "accept-language": "en-US,en;q=0.9",
    },
    body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
  });
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (resp.status !== 200) {
    throw new Error(`WebLogin HTTP ${resp.status}: ${new TextDecoder().decode(buf).slice(0, 200)}`);
  }
  const dataLen = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
  return protoMod.WebLoginResponse.decode(buf.subarray(5, 5 + dataLen)) as Record<string, unknown>;
}

const r1 = await postWebLogin(
  { webLoginHeaderBrowser: headerBrowserBase, loginIdentifier: { $case: "username", username: state.username } },
  `/v2/login?continue=${encodeURIComponent(continueParam)}`,
);
console.log(`[e2e] step1 status=${(r1 as { statusCode: number }).statusCode}, payload=${(r1 as { payload?: { $case: string } }).payload?.$case}`);

const sessionPayload = (r1 as { authenticationSessionPayload: Uint8Array }).authenticationSessionPayload;
const r2 = await postWebLogin(
  {
    webLoginHeaderBrowser: { ...headerBrowserBase, authenticationSessionPayload: sessionPayload },
    challengeAnswer: {
      challengeAnswer: {
        $case: "passwordChallengeAnswer",
        passwordChallengeAnswer: { password: state.password },
      },
    },
  },
  `/v2/password?continue=${encodeURIComponent(continueParam)}&ai=${Buffer.from(state.username).toString("base64").replace(/=+$/, "")}`,
);
const r2Status = (r2 as { statusCode: number }).statusCode;
const r2Payload = (r2 as { payload?: { $case: string; bootstrapDataBrowser?: { redirectUrl?: string; clientCookieValue?: string } } }).payload;
console.log(`[e2e] step2 status=${r2Status}, payload=${r2Payload?.$case}`);
const cookies1 = await jar.getCookies("https://accounts.snapchat.com");
const authCookie = cookies1.find((c) => c.key === "__Host-sc-a-auth-session");
if (!authCookie) {
  console.error(`[e2e] ✗ no __Host-sc-a-auth-session in jar — login failed`);
  process.exit(2);
}
console.log(`[e2e] ✓ phase 1: cookie captured (${authCookie.value.length} chars)`);

console.log(`\n[e2e] === phase 2: SSO redirect to mint bearer ===`);
const ssoUrl = `https://accounts.snapchat.com${continueParam}`;
const ssoResp = await jarFetch(ssoUrl, {
  method: "GET",
  headers: { referer: "https://accounts.snapchat.com/v2/password" },
  redirect: "manual",
});
console.log(`[e2e] sso → ${ssoResp.status}`);
const location = ssoResp.headers.get("location");
console.log(`[e2e] sso Location: ${location?.slice(0, 200)}…`);
let bearer: string | null = null;
if (location) {
  const m = location.match(/[#&]ticket=([^&#]+)/);
  if (m) bearer = decodeURIComponent(m[1]);
}
if (!bearer) {
  // Some flows POST /accounts/sso instead — try that.
  console.log(`[e2e] no ticket in 303; trying POST /accounts/sso…`);
  const ssoPost = await jarFetch(ssoUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: "https://accounts.snapchat.com/v2/password",
    },
    body: "",
    redirect: "manual",
  });
  console.log(`[e2e] sso POST → ${ssoPost.status}`);
  const loc2 = ssoPost.headers.get("location");
  console.log(`[e2e] sso POST Location: ${loc2?.slice(0, 200)}…`);
  if (loc2) {
    const m = loc2.match(/[#&]ticket=([^&#]+)/);
    if (m) bearer = decodeURIComponent(m[1]);
  }
}
if (!bearer) {
  console.error(`[e2e] ✗ couldn't extract bearer ticket from SSO redirect`);
  process.exit(3);
}
console.log(`[e2e] ✓ phase 2: bearer captured (${bearer.length} chars): ${bearer.slice(0, 60)}…`);

// Visit www.snapchat.com/web with the ticket fragment so any cookies that
// page sets (parent-domain cookies that AtlasGw expects) land in the jar.
// Browser would do this when the SSO redirect lands.
const ticketUrl = location ?? "https://www.snapchat.com/web";
console.log(`[e2e] visiting www.snapchat.com to seed www-domain cookies…`);
const wwwResp = await jarFetch(ticketUrl, {
  method: "GET",
  headers: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    referer: "https://accounts.snapchat.com/",
  },
});
console.log(`[e2e] www.snapchat.com → ${wwwResp.status}`);
const wwwCookies = await jar.getCookies("https://www.snapchat.com/");
console.log(`[e2e] cookies for www.snapchat.com: ${wwwCookies.map((c) => c.key).join(", ")}`);

console.log(`\n[e2e] === phase 3: AtlasGw/SyncFriendData with native bearer ===`);
const atlasUrl = "https://web.snapchat.com/com.snapchat.atlas.gw.AtlasGw/SyncFriendData";

// Build a minimal SyncFriendData request. The protobuf has many optional
// fields; sending an empty `outgoingSyncRequest` with `requestType: { $case: "all" }`
// should ask the server for the full friend list.
const chatBundlePath = join(
  import.meta.dir,
  "..",
  "vendor",
  "snap-bundle",
  "cf-st.sc-cdn.net",
  "dw",
  "9846a7958a5f0bee7197.js",
);
console.log(`[e2e] loading chat bundle for proto types…`);
const chatSrc = readFileSync(chatBundlePath, "utf8");
new Function("module", "exports", "require", chatSrc)(
  { exports: {} }, {}, () => { throw new Error("no req"); },
);
// The chat bundle pushes into `webpackChunk_snapchat_web_calling_app`,
// not the accounts `webpackChunk_N_E`. Our hook captured the factories,
// but the accounts webpack runtime never processed them — they're not in
// p.m. Manually merge so wreq() finds them.
//
// Module-id collision with accounts is possible in principle, but unlikely
// for the IDs we care about (74052 = AtlasGw is chat-specific). Take chat
// IDs as-authoritative on overlap; chat's view is what matters here.
const chatArr = (globalThis as unknown as Record<string, unknown[]>)["webpackChunk_snapchat_web_calling_app"];
let merged = 0;
if (Array.isArray(chatArr)) {
  for (const chunk of chatArr) {
    if (!Array.isArray(chunk) || chunk.length < 2) continue;
    const mods = chunk[1] as Record<string, Function>;
    if (mods && typeof mods === "object") {
      for (const id in mods) {
        wreq.m[id] = mods[id];
        merged++;
      }
    }
  }
}
console.log(`[e2e] merged ${merged} chat factories into p.m; total now: ${Object.keys(wreq.m).length}`);

let atlasGwExp: Record<string, unknown>;
try {
  atlasGwExp = wreq("74052") as Record<string, unknown>;
} catch (e) {
  console.error(`[e2e] couldn't require AtlasGw module: ${(e as Error).message}`);
  process.exit(4);
}
let AtlasClass: (new (rpc: unknown) => Record<string, Function>) | null = null;
for (const k of Object.keys(atlasGwExp)) {
  const v = atlasGwExp[k];
  if (typeof v !== "function") continue;
  const proto = (v as { prototype?: Record<string, unknown> }).prototype;
  if (proto && typeof proto.SyncFriendData === "function") {
    AtlasClass = v as new (rpc: unknown) => Record<string, Function>;
    break;
  }
}
if (!AtlasClass) {
  console.error(`[e2e] AtlasGw class not found in module 74052`);
  process.exit(4);
}

const rpc = {
  unary: async (method: { methodName: string; service?: { serviceName?: string }; requestType?: { serializeBinary?: () => Uint8Array }; responseType?: { decode?: (b: Uint8Array) => unknown } }, request: unknown): Promise<unknown> => {
    let reqBytes: Uint8Array;
    if (typeof method.requestType?.serializeBinary === "function") {
      reqBytes = method.requestType.serializeBinary.call(request);
    } else {
      throw new Error("unknown request encoder");
    }
    const framed = new Uint8Array(5 + reqBytes.byteLength);
    framed[0] = 0;
    new DataView(framed.buffer).setUint32(1, reqBytes.byteLength, false);
    framed.set(reqBytes, 5);
    const r = await jarFetch(atlasUrl, {
      method: "POST",
      headers: {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        authorization: `Bearer ${bearer}`,
        referer: "https://www.snapchat.com/",
        origin: "https://www.snapchat.com",
      },
      body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    console.log(`[e2e] AtlasGw ← ${r.status} ${buf.byteLength} bytes (grpc-status=${r.headers.get("grpc-status") ?? "—"})`);
    if (r.status !== 200) {
      throw new Error(`HTTP ${r.status}: ${new TextDecoder().decode(buf).slice(0, 300)}`);
    }
    if (buf.byteLength < 5) {
      throw new Error("response too short for gRPC-Web frame");
    }
    const dl = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
    return method.responseType?.decode?.(buf.subarray(5, 5 + dl));
  },
};

const client = new AtlasClass(rpc);
console.log(`[e2e] calling AtlasGw.SyncFriendData…`);
try {
  const result = await (client.SyncFriendData as Function).call(client, {
    outgoingSyncRequest: { requestType: { $case: "all", all: {} } },
  });
  console.log(`[e2e] ✓ phase 3: SyncFriendData returned`);
  const r = result as Record<string, unknown>;
  console.log(`[e2e] response keys: ${Object.keys(r).join(", ")}`);
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (Array.isArray(v)) console.log(`  ${k}: array len=${v.length}`);
    else if (v instanceof Uint8Array) console.log(`  ${k}: <bytes ${v.byteLength}>`);
    else if (v && typeof v === "object") console.log(`  ${k}: object keys=[${Object.keys(v).join(",")}]`);
    else console.log(`  ${k}: ${typeof v} = ${String(v).slice(0, 80)}`);
  }
  console.log(`[e2e] full sample (1500 chars):`);
  console.log(JSON.stringify(r, replacer, 2).slice(0, 1500));
} catch (e) {
  console.error(`[e2e] ✗ phase 3: ${(e as Error).message?.slice(0, 500)}`);
  process.exit(5);
}

function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array) return `<bytes ${v.byteLength}>`;
  return v;
}

console.log(`\n[e2e] 🎉 ALL PHASES COMPLETE — native login → bearer → API works`);
process.exit(0);
