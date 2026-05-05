/**
 * Bundle-driven logout.
 *
 * Calls Snap's own `state.auth.logout(force)` thunk — clears Zustand,
 * fires any subscribed teardown hooks, and (best-effort) revokes
 * server-side. Does NOT delete cookie-jar entries from the DataStore.
 *
 * @internal
 */
import { authSlice } from "../../bundle/register/index.ts";
import type { ClientContext } from "../_context.ts";

/**
 * Tear down the bundle-side auth state.
 *
 * Calls Snap's own `state.auth.logout(force)` thunk — clears Zustand,
 * fires any subscribed teardown hooks, and (best-effort) revokes
 * server-side.
 *
 * @param ctx - Per-instance client context.
 * @param force - If `true`, force the logout even if server-side revoke
 * fails.
 *
 * @remarks
 * Does NOT delete cookie-jar entries from the DataStore; consumers who
 * want a "wipe everything" flow should also call
 * `dataStore.delete("cookie_jar")` (or equivalent).
 *
 * @internal
 */
export async function logout(ctx: ClientContext, force?: boolean): Promise<void> {
  await authSlice(ctx.sandbox).logout(force);
}
