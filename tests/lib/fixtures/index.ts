/**
 * Bundle slice-state fixture barrel.
 *
 * Re-exports the per-slice fixture builders + a top-level `chatStateFixture`
 * for tests that want a fully-composed {@link ChatState} (the slice union
 * `chatStore(sandbox).getState()` returns).
 *
 * Usage:
 * ```ts
 * import { chatStateFixture, smallGraphUserSliceFixture } from "../lib/fixtures";
 *
 * const sandbox = mockSandbox()
 *   .withChatStore(chatStateFixture({
 *     user: smallGraphUserSliceFixture(),
 *   }))
 *   .build();
 * ```
 */
import type { ChatState } from "../../../src/bundle/types/index.ts";
import { authSliceFixture } from "./auth-slice.ts";
import { messagingSliceFixture } from "./messaging-slice.ts";
import { presenceSliceFixture } from "./presence-slice.ts";
import { userSliceFixture } from "./user-slice.ts";

export * from "./auth-slice.ts";
export * from "./messaging-slice.ts";
export * from "./presence-slice.ts";
export * from "./user-slice.ts";

/**
 * Build a fully-composed {@link ChatState} from the four slice fixtures.
 * Each slot defaults to its slice fixture's default; overrides win.
 *
 * @param overrides - per-slice overrides; partial-by-slice spread.
 * @returns A fresh `ChatState` ready to feed into
 * `mockSandbox().withChatStore(...)`.
 */
export function chatStateFixture(overrides: Partial<ChatState> = {}): ChatState {
  return {
    auth: overrides.auth ?? authSliceFixture(),
    user: overrides.user ?? userSliceFixture(),
    presence: overrides.presence ?? presenceSliceFixture(),
    messaging: overrides.messaging ?? messagingSliceFixture(),
  };
}
