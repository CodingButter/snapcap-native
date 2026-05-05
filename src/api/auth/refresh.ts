/**
 * Bundle-driven bearer refresh.
 *
 * Calls Snap's own `state.auth.refreshToken(reason, attestation)` —
 * needs an existing bearer in the slice + a fresh kameleon attestation
 * bound to the current username.
 *
 * @internal
 */
import { getKameleon } from "../../bundle/accounts-loader.ts";
import { authSlice } from "../../bundle/register/index.ts";
import type { ClientContext } from "../_context.ts";

/**
 * Refresh the bearer in-place via Snap's own `state.auth.refreshToken`.
 *
 * @param ctx - Per-instance client context.
 * @param username - Active identifier the kameleon attestation will be
 * bound to (must match the username the slice's existing bearer was
 * minted for).
 * @param reason - Refresh reason label; defaults to `"page_load"`.
 *
 * @remarks
 * The bundle's refresh path requires:
 *
 *   - An existing bearer in the auth slice (chicken-and-egg with first
 *     mint — call `authenticate()` first).
 *   - A fresh kameleon attestation (per `test-bundle-refresh.ts`
 *     findings — the slice's `refreshToken(reason, attestation)` second
 *     arg expects a token bound to the current username).
 *
 * The username binding for the attestation comes from the slice's
 * already-populated `authToken` payload — the SDK needs to know the
 * username at refresh time. Surfaced as the second arg here so callers
 * who track the username out-of-band can pass it in directly.
 *
 * @internal
 */
export async function refreshAuthToken(
  ctx: ClientContext,
  username: string,
  reason: string = "page_load",
): Promise<void> {
  const { ctx: kameleon } = await getKameleon(ctx.sandbox);
  const attestation = await kameleon.finalize(username);
  await authSlice(ctx.sandbox).refreshToken(reason, attestation);
}
