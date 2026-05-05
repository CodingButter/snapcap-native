/**
 * Warm-path: mint a fresh bearer from cookies already in the jar.
 *
 * If the cookie jar holds a non-expired `__Host-sc-a-auth-session`,
 * call {@link mintAndInitialize} (which hits the SSO redirect and
 * passes the resulting ticket to `state.auth.initialize`). On any
 * failure (no cookie, expired, server-rejected) returns `false` so the
 * caller can fall through to the cold-path 2-step WebLogin.
 *
 * Snap's session cookie is long-lived (~weeks); a successful warm path
 * costs ~1 SSO redirect (~100ms) vs cold's 2-step WebLogin + kameleon
 * attestation (~5s).
 *
 * @internal
 */
import { getOrCreateJar } from "../../shims/cookie-jar.ts";
import type { ClientContext } from "../_context.ts";
import { mintAndInitialize } from "./mint-and-initialize.ts";

/**
 * Warm path: if the cookie jar already has a non-expired
 * `__Host-sc-a-auth-session`, try to mint a fresh bearer from it
 * (no password required). Returns true on success, false if the cookie
 * is missing, expired, or the SSO endpoint rejects it.
 *
 * Snap's session cookie is long-lived (~weeks); a successful warm path
 * costs ~1 SSO redirect (~100ms) vs cold's 2-step WebLogin + kameleon
 * attestation (~5s).
 *
 * @internal
 */
export async function tryMintFromExistingCookies(ctx: ClientContext): Promise<boolean> {
  // Read from the SHARED jar (the one the bundle's XHR-driven fetches
  // also write to via the cookie-container shim). `ctx.jar.jar` is the
  // `CookieJarStore` wrapper's own deserialized jar — created once at
  // ctx-init time, so it doesn't see writes the shim landed afterward.
  const jar = getOrCreateJar(ctx.dataStore);
  const cookies = await jar.getCookies("https://accounts.snapchat.com");
  const session = cookies.find((c) => c.key === "__Host-sc-a-auth-session");
  if (!session) return false;
  // Tough-cookie strips already-expired cookies; if it's still here it's
  // at least not past `Max-Age`. We let the SSO endpoint be the final
  // arbiter — it'll redirect without a ticket if the cookie's been
  // server-revoked.
  try {
    await mintAndInitialize(ctx);
    return true;
  } catch {
    return false;
  }
}
