/**
 * SSO bearer minting + visit-www-snapchat seeding.
 *
 * After WebLoginService gives us `__Host-sc-a-auth-session`, we still need
 * a Bearer token to call the gRPC services on web.snapchat.com. The
 * browser gets one by:
 *   1. GET /accounts/sso?client_id=… → 303 redirect with
 *      `Location: https://www.snapchat.com/web#ticket=<bearer>`
 *   2. Following that redirect to www.snapchat.com (which sets parent-domain
 *      cookies like sc-a-nonce, _scid, sc_at — gRPC endpoints require those
 *      alongside the Bearer or they 401).
 *
 * /web-chat-session/refresh is for renewing an existing bearer (it returns
 * 200 with empty body); first issuance is via this redirect fragment.
 */
import type { CookieJar } from "tough-cookie";
import { makeJarFetch } from "../transport/cookies.ts";

export type MintBearerOpts = {
  jar: CookieJar;
  userAgent: string;
  /** continueParam used at login time. Must match for SSO to issue a ticket. */
  continueParam?: string;
};

export type BearerResult = {
  bearer: string;
  /** Final landing URL after the SSO redirect — useful as referer for later calls. */
  landingUrl: string;
};

const ACCOUNTS_HOST = "https://accounts.snapchat.com";
const DEFAULT_CONTINUE =
  "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb";

export async function mintBearer(opts: MintBearerOpts): Promise<BearerResult> {
  const jarFetch = makeJarFetch(opts.jar, opts.userAgent);
  const ssoUrl = `${ACCOUNTS_HOST}${opts.continueParam ?? DEFAULT_CONTINUE}`;

  // GET first — that's what the browser does after the password page submits.
  let resp = await jarFetch(ssoUrl, {
    method: "GET",
    headers: { referer: `${ACCOUNTS_HOST}/v2/password` },
    redirect: "manual",
  });
  let location = resp.headers.get("location");
  let bearer = location ? extractTicket(location) : null;

  if (!bearer) {
    // Some flows want POST instead. Browser does POST when the SSO is part of
    // an OAuth-style consent screen. Worth trying as a fallback.
    resp = await jarFetch(ssoUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: `${ACCOUNTS_HOST}/v2/password`,
      },
      body: "",
      redirect: "manual",
    });
    location = resp.headers.get("location");
    if (location) bearer = extractTicket(location);
  }

  if (!bearer || !location) {
    throw new Error(
      `couldn't extract bearer from SSO redirect (status=${resp.status}, location=${location?.slice(0, 100) ?? "(none)"})`,
    );
  }

  // Visit www.snapchat.com so the browser-side cookies (sc-a-nonce, _scid,
  // sc_at) get seeded into the jar. AtlasGw and friends require these
  // alongside the Bearer; otherwise the gRPC call returns 401.
  await jarFetch(location, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: `${ACCOUNTS_HOST}/`,
    },
  });

  return { bearer, landingUrl: location };
}

function extractTicket(location: string): string | null {
  const m = location.match(/[#&]ticket=([^&#]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}
