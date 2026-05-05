/**
 * User-domain bundle accessors — the `user` Zustand slice on the
 * chat-bundle store, and a pure projection helper for use by subscription
 * code that already has a {@link ChatState} snapshot in hand.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { ChatState, UserSlice } from "../types/index.ts";
import { chatStore } from "./chat.ts";

/**
 * User slice — Zustand store on chat module 94704.
 *
 * Carries the friend graph (`mutuallyConfirmedFriendIds`), pending
 * requests (`incomingFriendRequests`, `outgoingFriendRequestIds`), and
 * the `publicUsers` cache populated by `GetSnapchatterPublicInfo`.
 * Mutated in place by Immer drafts; subscribers should use
 * {@link chatStore}().subscribe for delta detection.
 *
 * See {@link UserSlice}.
 *
 * @internal Bundle-layer accessor. Public consumers reach friend / user
 * data via the api layer.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `user` slice from the chat-bundle state
 */
export const userSlice = (sandbox: Sandbox): UserSlice =>
  (chatStore(sandbox).getState() as ChatState).user;

/**
 * Project the `user` slice out of a chat-bundle `ChatState`.
 *
 * Pure thunk — exists so subscribers don't have to reach for
 * `state.user.*` directly (and so the per-slice diffing API stays
 * uniform across api files).
 *
 * @internal Bundle-layer projection helper.
 * @param state - a {@link ChatState} snapshot from the chat-bundle store
 * @returns the `user` slice of `state`
 */
export const userSliceFrom = (state: ChatState): UserSlice => state.user;
