/**
 * Bundle presence shapes — the per-conv `BundlePresenceSession` (chat
 * main byte ~6056117, module 73127) and the `state.presence` slice
 * (`PresenceSlice`) that owns the lifecycle thunks
 * (`initializePresenceServiceTs`, `createPresenceSession`,
 * `broadcastTypingActivity`, etc.).
 *
 * The slice's `presenceSession` slot is single-at-a-time globally; the
 * SDK serializes typing-pulse work through this slot via
 * `Messaging.setTyping`.
 */

/**
 * `state.presence.presenceSession` — what the slice's
 * `createPresenceSession(convId)` action populates after the
 * `PresenceServiceImpl` builds a real `ChatPresenceSession` (chat main
 * byte ~6056117, module 73127). Carries the `onUserAction` entry point
 * the bundle's typing/viewing/idle reducers drive.
 *
 * Action shapes (`a` arg of `onUserAction`):
 *   - `{type: "chatVisible", typingState: {state: "active" | "inactive"}}`
 *     — primes the gate that allows `propagateTypingStateChange` to fire
 *     (without the gate, modern Snap mobile clients ignore the convMgr
 *     typing pulse).
 *   - `{type: "chatHidden"}` — clears the gate and emits a final presence
 *     frame so the recipient's "viewing" / "typing" indicators clear.
 *   - `{type: "typing", typingAction: {activity: "typing" | "finished",
 *     activityType: "text"}}` — broadcasts a typing pulse; gated on
 *     `awayState === Present` AND a matching presence session existing
 *     for the conv.
 *
 * @internal Bundle wire-format type.
 */
export interface BundlePresenceSession {
  /**
   * Conversation envelope (`{id: Uint8Array(16), str: hyphenated-uuid}`)
   * the slice was constructed with — the bundle stores it verbatim. Use
   * `.str` for human-readable comparison.
   */
  conversationId: { id: Uint8Array; str: string };
  /** Drive presence state changes — see action shapes above. */
  onUserAction: (action: { type: string; [k: string]: unknown }) => void;
  /** Idempotent dispose; fires a final "chatHidden"-equivalent and
   * clears the slice's `presenceSession` slot. */
  dispose: () => void;
  /** Per-remote-participant state slots (typing / call / etc). */
  state: unknown[];
}

/**
 * `state.presence` slice on the bundle's Zustand store — module 94704.
 *
 * Constructed by factory `Zn(set, get)` at chat main byte ~8310100
 * (within the 94704 store factory). Methods:
 *
 *   - `initializePresenceServiceTs(duplexClient)` — constructs
 *     `PresenceServiceImpl` (`new tn.nv(...)`, module 48712) wired
 *     against the duplex client. **Must run once** before any
 *     `createPresenceSession` call. The duplex client is the bundle's
 *     React-built shape (`{registerHandler, send, addStreamListener,
 *     ...}`); we synthesize ours via `bundle/presence-bridge.ts`.
 *   - `createPresenceSession(convId)` — creates a per-conv session;
 *     returns a cleanup thunk. Side-effect: populates
 *     `state.presence.presenceSession` (one-at-a-time globally).
 *   - `broadcastTypingActivity(convId, activity)` — gated on
 *     `state.presence.presenceSession.conversationId === convId` AND
 *     `state.presence.awayState === Present`. Equivalent to
 *     `presenceSession.onUserAction({type: "typing",
 *      typingAction: {activity, activityType: "text"}})`.
 *   - `setAwayState(state)` — Present / Away enum value (see remarks).
 *   - `presenceSession` — current session (single-slot, not
 *     per-conversation).
 *   - `awayState` — initialized from `document.hasFocus()`; we patch
 *     `document.hasFocus = () => true` in the chat realm before bundle
 *     eval so this always lands as `Present`.
 *   - `destroyPresenceServiceTs` — tear-down counterpart to
 *     `initializePresenceServiceTs`.
 *
 * Speculative slots (`activeConversationInfo`, `screenshotDetected`,
 * `setScreenshotDetected`, `onCallStateChange`, `onActiveConversationInfoUpdated`)
 * are exposed for completeness; the SDK currently only drives the typing
 * / chatVisible / chatHidden path.
 *
 * @internal Bundle wire-format type.
 */
export interface PresenceSlice {
  initializePresenceServiceTs: (duplexClient: unknown) => void;
  destroyPresenceServiceTs: () => void;
  /**
   * Accepts a chat-realm conversation envelope (`{id, str}`), NOT a bare
   * UUID string — the slice's internal `s.QA(convEnv)` reads `.str` and
   * the `mt.Rv(convEnv)` selector reads `[QA(convEnv)]` from
   * `state.messaging.conversations`. Passing a bare string crashes
   * synchronously inside `s.QA` with `e[t+0]`.
   */
  createPresenceSession: (convEnvelope: { id: Uint8Array; str: string }) => () => void;
  /** `convEnvelope` shape same as {@link createPresenceSession}. */
  broadcastTypingActivity: (
    convEnvelope: { id: Uint8Array; str: string },
    activity: string,
  ) => void;
  setAwayState: (state: unknown) => void;
  setScreenshotDetected: (detected: boolean) => void;
  onActiveConversationInfoUpdated: (info: unknown) => void;
  onCallStateChange: (event: unknown) => void;
  /** Single-slot — only one active presence session globally. */
  presenceSession: BundlePresenceSession | undefined;
  /** Initialized from `document.hasFocus()` at slice creation time. */
  awayState: unknown;
  activeConversationInfo: Map<unknown, unknown>;
  screenshotDetected: boolean;
}
