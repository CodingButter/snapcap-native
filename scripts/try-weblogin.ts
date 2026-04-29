/**
 * WebLoginService diagnostic — drives the 2-step login by hand.
 *
 * The SDK's SnapcapClient.fromCredentials() does this internally; this
 * script is for when something breaks (Snap changes a field, an attestation
 * shape rotates, a status code is novel) and you need to see every step in
 * isolation. Run it as the canonical "is WebLoginService still working
 * the way we think" probe.
 *
 * Expected outcomes:
 *   - step 1: 200 + `challengeData.passwordChallenge` (server accepts attestation, asks for password)
 *   - step 2: 200 + `bootstrapDataBrowser` + Set-Cookie __Host-sc-a-auth-session
 *   - any other shape → either Snap changed something or the cookie jar/
 *     native-fetch capture order broke (happy-dom shimmed fetch strips
 *     Set-Cookie — see src/transport/native-fetch.ts).
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

// Stash Node/Bun's native fetch BEFORE bootKameleon installs happy-dom shims.
// happy-dom replaces globalThis.fetch with its own implementation that
// strips Set-Cookie headers (cookies live in the document instead) — useless
// for us since we want a manual jar to drive subsequent gRPC-Web calls.
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

// Cookie jar shared across all calls. Real browsers visit /v2/login first,
// which seeds tracking cookies (sc-language, sc-wcid, blizzard_client_id…).
// Without those, Snap's anti-fraud silently rejects WebLogin (returns
// statusCode=1 with empty bootstrapDataBrowser instead of setting cookies).
const jar = new CookieJar();
async function jarFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const cookieHeader = await jar.getCookieString(url);
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
  const resp = await nativeFetch(url, { ...init, headers });
  // Persist Set-Cookie. Bun's getSetCookie returns each cookie line.
  const setCookies =
    (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  for (const c of setCookies) {
    try {
      await jar.setCookie(c, url);
    } catch {
      /* tolerate odd cookies */
    }
  }
  return resp;
}

// Seed cookies by fetching the login page like a real browser would.
console.log(`[wl] seeding cookies via GET /v2/login…`);
const seedResp = await jarFetch(
  "https://accounts.snapchat.com/v2/login?continue=%2Faccounts%2Fsso%3Fclient_id%3Dweb-calling-corp--prod%26referrer%3Dhttps%253A%252F%252Fwww.snapchat.com%252Fweb",
  { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } },
);
console.log(`[wl] seed → ${seedResp.status}, jar now has ${(await jar.getCookies("https://accounts.snapchat.com")).length} cookies`);
// Debug: show all seed response headers
console.log(`[wl] seed response headers:`);
seedResp.headers.forEach((v, k) => console.log(`    ${k}: ${v.slice(0, 200)}`));
const seedSC = (seedResp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
console.log(`[wl] seed getSetCookie() returned: ${seedSC?.length ?? "undefined"}`);

console.log(`[wl] boot kameleon for ${state.username}…`);
await bootKameleon({ page: "www_login" });
const w = globalThis as unknown as {
  __snapcap_p: { (id: string): unknown; m: Record<string, Function> };
};
const wreq = w.__snapcap_p;

console.log(`[wl] generating attestation…`);
// Mint a fresh token. The kameleon Module is already booted; just call
// AttestationSession.instance().finalize directly via the cached factory.
const kamFactory = wreq("58116") as { default?: Function };
// Re-mint via the boot helper exported context; simpler.
import { bootKameleon as bk } from "../src/auth/kameleon.ts";
const kamCtx = await bk({ page: "www_login" });  // idempotent — shims/captures already installed
const attestation = await kamCtx.finalize(state.username);
console.log(`[wl] attestation len=${attestation.length}`);

// Pull protobuf types and method descriptor.
console.log(`[wl] pulling proto types…`);
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
  WebLoginServiceWebLoginDesc: {
    methodName: string;
    service: { serviceName: string };
  };
};
console.log(`[wl] desc = ${desc.WebLoginServiceWebLoginDesc.service.serviceName}/${desc.WebLoginServiceWebLoginDesc.methodName}`);

// Build the request. Mirrors what the login form's submit handler does in
// the browser bundle (see _app pages/v2/login).
const reqObj = {
  webLoginHeaderBrowser: {
    authenticationSessionPayload: new Uint8Array(),
    attestationPayload: new TextEncoder().encode(attestation),
    arkoseToken: "",
    ssoClientId: "",
    continueParam: "",
    multiUser: false,
    captchaPayload: {
      provider: 0, // UNKNOWN_UNSET
      payload: "",
      errorMessage: "",
    },
  },
  loginIdentifier: {
    $case: "username" as const,
    username: state.username,
  },
};
const partial = protoMod.WebLoginRequest.fromPartial(reqObj);
console.log(`[wl] partial built; keys: ${Object.keys(partial).join(", ")}`);
const reqBytes = protoMod.WebLoginRequest.encode(partial).finish();
console.log(`[wl] encoded request: ${reqBytes.byteLength} bytes`);

// gRPC-Web frame: 1-byte flag (0 = data) + 4-byte big-endian length + payload.
const framed = new Uint8Array(5 + reqBytes.byteLength);
framed[0] = 0;
new DataView(framed.buffer).setUint32(1, reqBytes.byteLength, false);
framed.set(reqBytes, 5);

const url = `https://accounts.snapchat.com/${desc.WebLoginServiceWebLoginDesc.service.serviceName}/${desc.WebLoginServiceWebLoginDesc.methodName}`;
console.log(`[wl] → POST ${url}`);
const resp = await jarFetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    referer: "https://accounts.snapchat.com/v2/login?continue=%2Faccounts%2Fsso%3Fclient_id%3Dweb-calling-corp--prod%26referrer%3Dhttps%253A%252F%252Fwww.snapchat.com%252Fweb",
    origin: "https://accounts.snapchat.com",
    "accept-language": "en-US,en;q=0.9",
  },
  body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
});
console.log(`[wl] ← ${resp.status} ${resp.headers.get("grpc-status") ?? ""}`);
console.log(`[wl] step1 ALL response headers:`);
resp.headers.forEach((v, k) => {
  console.log(`    ${k}: ${v.slice(0, 300)}`);
});
const setCookies1 = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
if (setCookies1) {
  console.log(`[wl] step1 set-cookies (${setCookies1.length}):`);
  for (const c of setCookies1) console.log(`    ${c.slice(0, 300)}`);
}

const respBuf = new Uint8Array(await resp.arrayBuffer());
console.log(`[wl] response body: ${respBuf.byteLength} bytes`);
if (resp.status !== 200) {
  console.log(`[wl] body preview: ${new TextDecoder().decode(respBuf).slice(0, 500)}`);
  process.exit(1);
}

// Strip 5-byte gRPC-Web frame header before decoding.
if (respBuf.byteLength < 5) {
  console.error(`[wl] response too short to be gRPC-Web framed`);
  process.exit(1);
}
const dataLen = new DataView(respBuf.buffer, respBuf.byteOffset + 1, 4).getUint32(0, false);
const payload = respBuf.subarray(5, 5 + dataLen);
console.log(`[wl] proto payload: ${payload.byteLength} bytes`);

const respMsg = protoMod.WebLoginResponse.decode(payload) as {
  statusCode: number;
  authenticationSessionPayload: Uint8Array;
  loginIdentifier: unknown;
  payload?: {
    $case: string;
    challengeData?: {
      challenge?: { $case: string; passwordChallenge?: object };
    };
    bootstrapDataBrowser?: object;
  };
  userId?: string;
};
console.log(`[wl] step1 status=${respMsg.statusCode}, payload=${respMsg.payload?.$case}`);

if (respMsg.payload?.$case !== "challengeData" ||
    respMsg.payload.challengeData?.challenge?.$case !== "passwordChallenge") {
  console.log(`[wl] unexpected response: ${JSON.stringify(respMsg, replacer, 2).slice(0, 1500)}`);
  process.exit(0);
}

console.log(`[wl] server requested password — answering…`);

// Step 2: send password. ChallengeAnswer is double-nested: the outer
// WebLoginRequest.challengeAnswer holds a ChallengeAnswer message whose
// own `challengeAnswer` is the oneof. Drop loginIdentifier — the password
// page omits it (server already knows the user from the session payload).
const step2Req = protoMod.WebLoginRequest.fromPartial({
  webLoginHeaderBrowser: {
    authenticationSessionPayload: respMsg.authenticationSessionPayload,
    attestationPayload: new TextEncoder().encode(attestation),
    arkoseToken: "",
    ssoClientId: "",
    continueParam: "",
    multiUser: false,
    captchaPayload: { provider: 0, payload: "", errorMessage: "" },
  },
  challengeAnswer: {
    challengeAnswer: {
      $case: "passwordChallengeAnswer",
      passwordChallengeAnswer: { password: state.password },
    },
  },
});
const step2Bytes = protoMod.WebLoginRequest.encode(step2Req).finish();
console.log(`[wl] step2 encoded: ${step2Bytes.byteLength} bytes`);
const framed2 = new Uint8Array(5 + step2Bytes.byteLength);
framed2[0] = 0;
new DataView(framed2.buffer).setUint32(1, step2Bytes.byteLength, false);
framed2.set(step2Bytes, 5);

const resp2 = await jarFetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    referer:
      "https://accounts.snapchat.com/v2/password?continue=%2Faccounts%2Fsso%3Fclient_id%3Dweb-calling-corp--prod%26referrer%3Dhttps%253A%252F%252Fwww.snapchat.com%252Fweb&ai=" +
      Buffer.from(state.username).toString("base64").replace(/=+$/, ""),
    origin: "https://accounts.snapchat.com",
    "accept-language": "en-US,en;q=0.9",
  },
  body: framed2.buffer.slice(framed2.byteOffset, framed2.byteOffset + framed2.byteLength) as ArrayBuffer,
});
console.log(`[wl] ← step2 ${resp2.status}`);
console.log(`[wl] step2 ALL response headers:`);
resp2.headers.forEach((v, k) => {
  console.log(`    ${k}: ${v.slice(0, 300)}`);
});
// Bun's Headers.forEach merges set-cookies. Use getSetCookie if available.
const setCookies = (resp2.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
if (setCookies) {
  console.log(`[wl] set-cookies (${setCookies.length}):`);
  for (const c of setCookies) console.log(`    ${c.slice(0, 300)}`);
}
const respBuf2 = new Uint8Array(await resp2.arrayBuffer());
console.log(`[wl] step2 body: ${respBuf2.byteLength} bytes`);
if (resp2.status !== 200) {
  console.log(`[wl] body: ${new TextDecoder().decode(respBuf2).slice(0, 500)}`);
  process.exit(1);
}
const dl2 = new DataView(respBuf2.buffer, respBuf2.byteOffset + 1, 4).getUint32(0, false);
const pl2 = respBuf2.subarray(5, 5 + dl2);
const respMsg2 = protoMod.WebLoginResponse.decode(pl2);
console.log(`[wl] step2 decoded:`);
console.log(JSON.stringify(respMsg2, replacer, 2).slice(0, 2500));

function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array) {
    return `<bytes len=${v.byteLength}: ${Buffer.from(v).toString("hex").slice(0, 80)}>`;
  }
  return v;
}

const finalCookies = await jar.getCookies("https://accounts.snapchat.com");
const authCookie = finalCookies.find((c) => c.key === "__Host-sc-a-auth-session");
if (authCookie) {
  console.log(`\n[wl] ✓ NATIVE LOGIN SUCCEEDED — captured __Host-sc-a-auth-session`);
  console.log(`    value (first 80): ${authCookie.value.slice(0, 80)}…`);
} else {
  console.log(`\n[wl] login finished but no __Host-sc-a-auth-session in jar.`);
  console.log(`    final cookies: ${finalCookies.map((c) => c.key).join(", ")}`);
}

process.exit(0);
