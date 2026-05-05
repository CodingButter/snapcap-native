/**
 * Shared type aliases for the bundle-driven auth surface.
 *
 * Kept tiny on purpose — the public {@link AuthState} enum mirrors
 * Snap's `state.auth.authState`, and {@link AuthSliceLive} is the
 * runtime-shape view of the slice that the live-read getters in
 * `auth-state.ts` peek into. Helper-only types for SSO ticket minting
 * live in `sso-ticket.ts` next to their consumer.
 *
 * @internal
 */

/**
 * `state.auth.authState` enum.
 *
 *   - `0` = LoggedOut
 *   - `1` = LoggedIn
 *   - `2` = Processing
 *   - `3` = MoreChallengesRequired
 *
 * @internal
 */
export type AuthState = 0 | 1 | 2 | 3;

/**
 * Live shape of the auth slice as exposed by `authSlice(ctx.sandbox)`.
 *
 * The `AuthSlice` type in `bundle/types.ts` only declares the methods
 * (initialize, logout, refreshToken, fetchToken); the live slice also
 * carries these reactive fields that the getters in `auth-state.ts`
 * peek for the public-surface live reads.
 *
 * @internal
 */
export interface AuthSliceLive {
  authToken: { token: string; lastTokenRefresh: number | undefined };
  authState: AuthState;
  hasEverLoggedIn: boolean;
}
