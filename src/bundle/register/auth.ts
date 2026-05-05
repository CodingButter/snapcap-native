/**
 * Auth-domain bundle accessors — the WebLogin client constructor and
 * the `auth` Zustand slice on the chat-bundle store.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { AuthSlice, ChatState, LoginClientCtor } from "../types.ts";
import { chatStore } from "./chat.ts";
import { G_LOGIN_CLIENT_IMPL } from "./patch-keys.ts";
import { reach } from "./reach.ts";

/**
 * Login client constructor — accounts module 13150
 * `WebLoginServiceClientImpl`.
 *
 * Construct with `new (loginClient(sandbox))({ unary }).WebLogin(req)`.
 * See {@link LoginClientCtor}.
 *
 * @internal Bundle-layer accessor. Public consumers reach login via
 * `SnapcapClient.authenticate()` (see `src/auth/login.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `WebLoginServiceClientImpl` constructor
 */
export const loginClient = (sandbox: Sandbox): LoginClientCtor =>
  reach<LoginClientCtor>(sandbox, G_LOGIN_CLIENT_IMPL, "loginClient");

/**
 * Auth slice — Zustand store on chat module 94704.
 *
 * Methods: `initialize`, `logout`, `refreshToken`, `fetchToken`
 * (PageLoad-time SPA only). See {@link AuthSlice}.
 *
 * @internal Bundle-layer accessor. Public consumers reach auth via
 * `SnapcapClient` methods (see `src/client.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `auth` slice from the chat-bundle state
 */
export const authSlice = (sandbox: Sandbox): AuthSlice =>
  (chatStore(sandbox).getState() as ChatState).auth;
