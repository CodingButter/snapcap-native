/**
 * Mint a fresh bearer from the SSO endpoint and hand it to the bundle.
 *
 * Uses the already-authenticated session cookies in the jar to mint a
 * ticket via {@link _mintTicketFromSSO}, then calls Snap's bundle-side
 * `state.auth.initialize(loc)` so the bundle writes the bearer into
 * Zustand: `authToken.token` populated, `authState=1`,
 * `hasEverLoggedIn=true`.
 *
 * The SDK plays "the browser" here — `initialize` expects the page's
 * URL hash to contain `?ticket=<bearer>`, normally landed there by the
 * SSO 303 redirect. We do the redirect ourselves and synthesize the
 * `loc` argument.
 *
 * @internal
 */
import { authSlice } from "../../bundle/register.ts";
import { getOrCreateJar } from "../../shims/cookie-jar.ts";
import type { ClientContext } from "../_context.ts";
import { _mintTicketFromSSO } from "./sso-ticket.ts";

/**
 * Mint a fresh ticket from the SSO endpoint (using the
 * already-authenticated session cookies in the jar) and hand it to
 * Snap's bundle-side `state.auth.initialize`. The bundle then writes
 * the bearer into Zustand: `authToken.token` populated, `authState=1`,
 * `hasEverLoggedIn=true`.
 *
 * SDK plays "the browser" here — Snap's `initialize` expects the page's
 * URL hash to contain `?ticket=<bearer>`, normally landed there by the
 * SSO 303 redirect. We do the redirect ourselves and synthesize the
 * `loc` argument.
 *
 * Throws if `_mintTicketFromSSO` can't extract a ticket from the SSO
 * redirect (cookie expired / server rejected) — `tryMintFromExistingCookies`
 * catches and returns false; cold-path callers let it propagate.
 *
 * @internal
 */
export async function mintAndInitialize(ctx: ClientContext): Promise<void> {
  // `_mintTicketFromSSO` runs SDK-side (host realm fetch) — it must use
  // the SAME jar the bundle's XHR shim writes to, otherwise the
  // auth-session cookies the bundle just landed aren't visible to the
  // SSO redirect. `getOrCreateJar` returns the WeakMap-cached jar
  // shared by every shim bound to this DataStore.
  const sharedJar = getOrCreateJar(ctx.dataStore);
  const { bearer } = await _mintTicketFromSSO({ jar: sharedJar, userAgent: ctx.userAgent });
  // Snap's `initialize` parses `loc.hash.slice(1)` then
  // `new URLSearchParams(...).get("ticket")` — slice(1) drops the leading
  // "#", so hash MUST start with "#" and the inner content must be
  // `ticket=<value>`.
  await authSlice(ctx.sandbox).initialize({
    hash: `#ticket=${encodeURIComponent(bearer)}`,
    search: "",
  });
}
