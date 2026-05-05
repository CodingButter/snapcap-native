/**
 * Bundle-driven auth orchestration — public barrel.
 *
 * Tier-2 api feature directory: composes the manager getters from
 * `../../bundle/register.ts` (the "registry of Snap managers") into a
 * coherent end-user surface. Stateless — every exported function takes
 * a `ClientContext` first arg.
 *
 * @remarks
 * Architecture:
 *
 * `authenticate(ctx, {username, password})` is the single entry point.
 * It composes four steps:
 *
 *   1. `bringUp(ctx)` — load accounts + chat bundles (idempotent).
 *   2. `tryMintFromExistingCookies(ctx)` — warm path: if the jar holds
 *      a non-expired `__Host-sc-a-auth-session`, GET `/accounts/sso` to
 *      extract a fresh ticket and call `initializeAuth(...)`. Returns
 *      true on success; false otherwise (no cookies, or server
 *      rejected).
 *   3. `fullLogin(ctx, opts)` — cold path: drive the bundle's own
 *      2-step `WebLogin` (the same flow as
 *      `scripts/test-bundle-login.ts`).
 *   4. `mintAndInitialize(ctx)` — after `fullLogin` lands the
 *      auth-session cookies, mint a ticket via the SSO redirect-follower
 *      (SDK plays "the browser") and write the bearer into Zustand via
 *      `state.auth.initialize`.
 *
 * Auth state reads (`isAuthenticated`, `getAuthToken`, …) are direct
 * Zustand-slice peeks — no caching, the slice is the source of truth.
 *
 * Architectural roles (per `project_architecture_pivot.md`):
 *
 *   - The SDK plays "the browser": follows the SSO 303 redirect,
 *     extracts the ticket from the URL hash, hands it back to the
 *     bundle.
 *   - The bundle owns state + protocol: Zustand auth slice, refresh
 *     logic, logout.
 *
 * @internal
 */

export { authenticate } from "./authenticate.ts";
export { logout } from "./logout.ts";
export { refreshAuthToken } from "./refresh.ts";
export {
  getAuthToken,
  getAuthState,
  isAuthenticated,
  hasEverLoggedIn,
} from "./auth-state.ts";
export { makeContext } from "./make-context.ts";
export { _mintTicketFromSSO } from "./sso-ticket.ts";

export type { AuthState } from "./types.ts";
export type { ClientContext } from "../_context.ts";
