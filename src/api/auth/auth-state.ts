/**
 * Live-read getters for the Zustand auth slice.
 *
 * Each function is a thin peek at `authSlice(ctx.sandbox)` — the slice
 * is the source of truth, no caching layered on top. Returns sensible
 * defaults if the bundle isn't brought up yet (rather than throwing —
 * lets a consumer call `isAuthenticated()` before `authenticate()`).
 *
 * @internal
 */
import { authSlice } from "../../bundle/register.ts";
import type { ClientContext } from "../_context.ts";
import type { AuthSliceLive, AuthState } from "./types.ts";

/**
 * Live read: current SSO bearer string from the Zustand auth slice.
 *
 * @internal
 */
export function getAuthToken(ctx: ClientContext): string {
  return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authToken.token;
}

/**
 * Live read: current {@link AuthState} enum value.
 *
 * @internal
 */
export function getAuthState(ctx: ClientContext): AuthState {
  return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authState;
}

/**
 * Convenience: `true` iff the auth slice currently reports `LoggedIn`.
 *
 * @internal
 */
export function isAuthenticated(ctx: ClientContext): boolean {
  try {
    return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authState === 1;
  } catch {
    // Bundle not yet brought up → definitely not authenticated.
    return false;
  }
}

/**
 * Convenience: `true` iff the user has logged in at any point in this
 * realm's lifetime (survives logout).
 *
 * Useful for distinguishing a fresh install from a signed-out returning
 * user.
 *
 * @internal
 */
export function hasEverLoggedIn(ctx: ClientContext): boolean {
  try {
    return (authSlice(ctx.sandbox) as unknown as AuthSliceLive).hasEverLoggedIn;
  } catch {
    return false;
  }
}
