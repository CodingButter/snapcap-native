/**
 * High-level entry: one-call bundle-driven authentication.
 *
 * Composes four steps:
 *
 *   1. {@link bringUp} — load accounts + chat bundles (idempotent).
 *   2. {@link tryMintFromExistingCookies} — warm path: if the jar
 *      holds a non-expired `__Host-sc-a-auth-session`, GET
 *      `/accounts/sso` to extract a fresh ticket and call
 *      `state.auth.initialize(...)`. Returns true on success.
 *   3. {@link fullLogin} — cold path: drive the bundle's own 2-step
 *      `WebLogin`.
 *   4. {@link mintAndInitialize} — after `fullLogin` lands the
 *      auth-session cookies, mint a ticket via SSO and write the
 *      bearer into Zustand via `state.auth.initialize`.
 *
 * After Zustand has a bearer, {@link kickoffMessagingSession} mints +
 * registers a Fidelius identity (non-fatal if it fails).
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import type { Credentials } from "../../types.ts";
import { bringUp } from "./bringup.ts";
import { tryMintFromExistingCookies } from "./mint-from-cookies.ts";
import { fullLogin } from "./full-login.ts";
import { mintAndInitialize } from "./mint-and-initialize.ts";
import { kickoffMessagingSession } from "./kickoff-messaging.ts";

/**
 * One-call authentication: brings up the bundles, tries the warm path
 * (existing cookies → mint a fresh bearer), and falls back to a full
 * 2-step WebLogin if no cookies are present or the warm path fails.
 *
 * @param ctx - Per-instance client context.
 * @param opts - Login credentials.
 * @throws On cold-path failure (bad creds, network error, server reject).
 * The warm path's failure is silent (returns false → we proceed to
 * cold).
 *
 * @remarks
 * Consumer-visible state lives in the Zustand auth slice; read via
 * `isAuthenticated` / `getAuthToken` after this resolves.
 *
 * @internal
 */
export async function authenticate(
  ctx: ClientContext,
  opts: { credentials: Credentials },
): Promise<void> {
  await bringUp(ctx);
  if (await tryMintFromExistingCookies(ctx)) {
    await kickoffMessagingSession(ctx);
    return;
  }
  await fullLogin(ctx, opts);
  await mintAndInitialize(ctx);
  await kickoffMessagingSession(ctx);
}
