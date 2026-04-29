/**
 * Native WebLoginService driver.
 *
 * Two-step flow that mirrors what the browser does on
 * accounts.snapchat.com/v2/login → /v2/password:
 *   1. POST WebLogin with attestation + identifier → server replies with
 *      `challengeData.passwordChallenge` and an authenticationSessionPayload
 *      we have to echo back.
 *   2. POST WebLogin again with that session payload + the password as a
 *      double-nested `challengeAnswer.challengeAnswer.passwordChallengeAnswer.password`.
 *
 * On success the server sets `__Host-sc-a-auth-session` (long-lived
 * refresh-style cookie) along with ~6 sibling cookies. They land in the
 * jar via the makeJarFetch helper.
 *
 * Kameleon attestation is generated against the username, page="www_login".
 * The token is non-determistic; a fresh one is needed for every login.
 */
import type { CookieJar } from "tough-cookie";
import { getKameleon, type KameleonOpts } from "./kameleon.ts";
import { makeJarFetch } from "../transport/cookies.ts";

export type LoginCredentials = { username: string; password: string };

export type LoginOpts = {
  credentials: LoginCredentials;
  jar: CookieJar;
  userAgent: string;
  /** Where the SSO flow expects to land afterward. Becomes the `continueParam` in the request. */
  continueParam?: string;
  kameleonOpts?: KameleonOpts;
};

const HOST = "https://accounts.snapchat.com";
const DEFAULT_CONTINUE =
  "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb";

export async function nativeLogin(opts: LoginOpts): Promise<void> {
  const { credentials, jar, userAgent } = opts;
  const continueParam = opts.continueParam ?? DEFAULT_CONTINUE;
  const jarFetch = makeJarFetch(jar, userAgent);

  const { ctx: kameleon, wreq } = await getKameleon(opts.kameleonOpts);
  const attestation = await kameleon.finalize(credentials.username);

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
  const url = `${HOST}/${desc.WebLoginServiceWebLoginDesc.service.serviceName}/${desc.WebLoginServiceWebLoginDesc.methodName}`;

  const headerBrowserBase = {
    authenticationSessionPayload: new Uint8Array(),
    attestationPayload: new TextEncoder().encode(attestation),
    arkoseToken: "",
    ssoClientId: "",
    continueParam,
    multiUser: false,
    captchaPayload: { provider: 0, payload: "", errorMessage: "" },
  };

  // Step 1: identifier + attestation.
  const r1 = await postWebLogin(
    url,
    jarFetch,
    protoMod,
    {
      webLoginHeaderBrowser: headerBrowserBase,
      loginIdentifier: { $case: "username", username: credentials.username },
    },
    `${HOST}/v2/login?continue=${encodeURIComponent(continueParam)}`,
  );
  const r1Payload = r1.payload as { $case?: string; challengeData?: { challenge?: { $case: string } } } | undefined;
  if (r1Payload?.$case === "errorData") {
    throw new Error(`WebLogin step 1 errorData: ${JSON.stringify(r1.payload)}`);
  }
  if (r1Payload?.$case !== "challengeData" ||
      r1Payload.challengeData?.challenge?.$case !== "passwordChallenge") {
    const innerCase = r1Payload?.challengeData?.challenge?.$case ?? "(none)";
    throw new Error(
      `WebLogin step 1 unexpected payload: outer=${r1Payload?.$case ?? "(none)"} inner=${innerCase}. ` +
      `Server may have escalated to a non-password challenge (captcha, TIV, 2FA, etc.) — ` +
      `run scripts/try-weblogin.ts to see the full response.`,
    );
  }

  const sessionPayload = r1.authenticationSessionPayload as Uint8Array;

  // Step 2: password answer.
  const r2 = await postWebLogin(
    url,
    jarFetch,
    protoMod,
    {
      webLoginHeaderBrowser: { ...headerBrowserBase, authenticationSessionPayload: sessionPayload },
      challengeAnswer: {
        challengeAnswer: {
          $case: "passwordChallengeAnswer",
          passwordChallengeAnswer: { password: credentials.password },
        },
      },
    },
    `${HOST}/v2/password?continue=${encodeURIComponent(continueParam)}&ai=${b64UrlNoPad(credentials.username)}`,
  );
  const r2Payload = r2.payload as { $case?: string } | undefined;
  if (r2Payload?.$case === "errorData") {
    throw new Error(`WebLogin step 2 errorData: ${JSON.stringify(r2.payload)}`);
  }
  if ((r2 as { statusCode?: number }).statusCode !== 1) {
    throw new Error(`WebLogin step 2 statusCode=${(r2 as { statusCode?: number }).statusCode}, expected 1`);
  }

  const authCookie = (await jar.getCookies(HOST)).find((c) => c.key === "__Host-sc-a-auth-session");
  if (!authCookie) {
    // Server returned success but didn't set the cookie. Either anti-fraud
    // shadow-rejection (fingerprint flagged) or response Set-Cookie was
    // stripped by a happy-dom-shimmed fetch (caller didn't capture native
    // fetch before installShims).
    throw new Error("login succeeded protocol-wise but no __Host-sc-a-auth-session in jar");
  }
}

async function postWebLogin(
  url: string,
  jarFetch: (u: string, i?: RequestInit) => Promise<Response>,
  protoMod: {
    WebLoginRequest: { fromPartial: (p: object) => object; encode: (msg: object) => { finish: () => Uint8Array } };
    WebLoginResponse: { decode: (b: Uint8Array) => Record<string, unknown> };
  },
  request: object,
  refererUrl: string,
): Promise<Record<string, unknown>> {
  const partial = protoMod.WebLoginRequest.fromPartial(request);
  const bytes = protoMod.WebLoginRequest.encode(partial).finish();
  const framed = new Uint8Array(5 + bytes.byteLength);
  framed[0] = 0;
  new DataView(framed.buffer).setUint32(1, bytes.byteLength, false);
  framed.set(bytes, 5);
  const resp = await jarFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      referer: refererUrl,
      origin: HOST,
      "accept-language": "en-US,en;q=0.9",
    },
    body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
  });
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (resp.status !== 200) {
    throw new Error(`WebLogin HTTP ${resp.status}: ${new TextDecoder().decode(buf).slice(0, 200)}`);
  }
  if (buf.byteLength < 5) {
    throw new Error("WebLogin response too short to be gRPC-Web framed");
  }
  const dataLen = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
  return protoMod.WebLoginResponse.decode(buf.subarray(5, 5 + dataLen)) as Record<string, unknown>;
}

function b64UrlNoPad(s: string): string {
  return Buffer.from(s).toString("base64").replace(/=+$/, "");
}
