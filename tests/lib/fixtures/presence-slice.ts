/**
 * Fixture builders for the chat-bundle `state.presence` slice.
 *
 * Covers the per-presence-state variants:
 *   - default (no session, awayState=Present)
 *   - active session (mid-typing-pulse)
 *   - away (awayState=Away)
 *   - in-call (presence session present, call state set)
 *
 * Every export is a function — fresh objects per call.
 *
 * Pair with {@link mockSandbox} from `../mock-sandbox.ts`.
 */
import type {
  BundlePresenceSession,
  PresenceSlice,
} from "../../../src/bundle/types/index.ts";

/**
 * Default empty presence slice — no active session, awayState=Present.
 * Most thunks are no-ops; tests that assert on calls should wrap them
 * with their own spies.
 *
 * @param overrides - shape to merge onto the default.
 */
export function presenceSliceFixture(
  overrides: Partial<PresenceSlice> = {},
): PresenceSlice {
  return {
    initializePresenceServiceTs: () => {},
    destroyPresenceServiceTs: () => {},
    createPresenceSession: () => () => {},
    broadcastTypingActivity: () => {},
    setAwayState: () => {},
    setScreenshotDetected: () => {},
    onActiveConversationInfoUpdated: () => {},
    onCallStateChange: () => {},
    presenceSession: undefined,
    awayState: "Present",
    activeConversationInfo: new Map(),
    screenshotDetected: false,
    ...overrides,
  };
}

/**
 * Build a {@link BundlePresenceSession} fixture for a given conversation.
 * The `onUserAction` / `dispose` callbacks are no-ops; tests can override
 * via `overrides`.
 *
 * @param conversationId - hyphenated conv UUID.
 * @param overrides - shape to merge.
 */
export function presenceSessionFixture(
  conversationId: string,
  overrides: Partial<BundlePresenceSession> = {},
): BundlePresenceSession {
  return {
    conversationId: { id: new Uint8Array(16), str: conversationId },
    onUserAction: () => {},
    dispose: () => {},
    state: [],
    ...overrides,
  };
}

/**
 * Active presence slice — has a session bound to `convId`, awayState=Present.
 * Use to test `setTyping` / `presence-out` paths that gate on session presence.
 *
 * @param convId - the conversation the session is bound to.
 * @param overrides - shape to merge.
 */
export function activePresenceSliceFixture(
  convId: string,
  overrides: Partial<PresenceSlice> = {},
): PresenceSlice {
  return presenceSliceFixture({
    presenceSession: presenceSessionFixture(convId),
    ...overrides,
  });
}

/**
 * Away presence slice — `awayState=Away`. Typing-pulse sends should
 * short-circuit on this state per the bundle's gating logic.
 *
 * @param overrides - shape to merge.
 */
export function awayPresenceSliceFixture(
  overrides: Partial<PresenceSlice> = {},
): PresenceSlice {
  return presenceSliceFixture({
    awayState: "Away",
    ...overrides,
  });
}
