/**
 * SSO ticket mint — SDK-side redirect-follower.
 *
 * Snap's `state.auth.initialize(loc)` expects a URL hash containing
 * `?ticket=<bearer>`, normally landed there by Snap's own SSO 303
 * redirect. The SDK plays "the browser" here: follow the redirect
 * ourselves, pull the bearer out of the `Location` header, synthesize
 * the `loc` argument for the bundle.
 *
 * Used by both warm path (cookies present → mint a fresh bearer), cold
 * path (full WebLogin → cookies seeded → mint via this), and the
 * legacy `client.ts` direct-RPC bearer chain (`refreshBearer` for 401
 * retry on tier-2 sends).
 *
 * @internal
 */
import { makeJarFetch, type JarLike } from "../../transport/cookies.ts";

/** Origin Snap's web client redirects through to mint a bearer. */
const SSO_HOST = "https://accounts.snapchat.com";

/** Default continueParam used at login time — must match for SSO to issue a ticket. */
const DEFAULT_SSO_CONTINUE =
  "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb";

/** Options for {@link _mintTicketFromSSO}. */
export type MintTicketOpts = {
  /**
   * Cookie source. Plain `CookieJar` or a DataStore-backed wrapper —
   * the GET to www.snapchat.com lands parent-domain cookies
   * (sc-a-nonce/_scid/sc_at) in the jar.
   */
  jar: JarLike;
  userAgent: string;
  /** continueParam used at login time. Must match for SSO to issue a ticket. */
  continueParam?: string;
};

/** Result returned by {@link _mintTicketFromSSO}. */
export type MintTicketResult = {
  bearer: string;
  /** Final landing URL after the SSO redirect — useful as referer for later calls. */
  landingUrl: string;
};

/**
 * Hit `accounts.snapchat.com/accounts/sso?...` with the current cookies
 * and pull the bearer ticket out of the 303 redirect's `Location` header.
 *
 * @param opts - SSO ticket-mint options.
 * @returns The bearer plus the final landing URL (useful as referer for
 * later calls).
 * @throws If neither GET nor POST against the SSO endpoint produces a
 * `Location` header containing `ticket=`.
 *
 * @remarks
 * Architectural role: the SDK plays "the browser" here — the bundle's
 * `state.auth.initialize(loc)` expects a URL hash containing
 * `?ticket=<bearer>`, normally landed there by Snap's own SSO 303
 * redirect. We follow the redirect ourselves and synthesize the `loc`
 * argument.
 *
 * Exported (with the underscore prefix flagging SDK-internal status) so
 * the legacy direct-RPC bearer chain in `client.ts` can reach it without
 * re-pulling the helper into a separate module.
 *
 * @internal
 */
export async function _mintTicketFromSSO(opts: MintTicketOpts): Promise<MintTicketResult> {
  const jarFetch = makeJarFetch(opts.jar, opts.userAgent);
  const ssoUrl = `${SSO_HOST}${opts.continueParam ?? DEFAULT_SSO_CONTINUE}`;

  // GET first — that's what the browser does after the password page submits.
  let resp = await jarFetch(ssoUrl, {
    method: "GET",
    headers: { referer: `${SSO_HOST}/v2/password` },
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
        referer: `${SSO_HOST}/v2/password`,
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
      referer: `${SSO_HOST}/`,
    },
  });

  return { bearer, landingUrl: location };
}

function extractTicket(location: string): string | null {
  // [#?&] covers all three positions Snap might use: fragment (#ticket=…),
  // first query param (?ticket=…), and subsequent params (&ticket=…).
  const m = location.match(/[#?&]ticket=([^&#]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}
