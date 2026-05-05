/**
 * Presence-domain bundle accessors — the `presence` Zustand slice and the
 * `O` enum module that backs its `awayState` slot.
 *
 * The {@link PresenceStateEnum} interface lives here (not in
 * `bundle/types.ts`) because the only consumers are the registry getter
 * `presenceStateEnum()` below and `client.ts`'s `setStatus`/`getStatus`
 * mapping — keeping the type co-located with its one bundle-side getter
 * avoids a cross-file rename when Snap changes the enum shape.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { ChatState, PresenceSlice } from "../types/index.ts";
import { chatStore } from "./chat.ts";
import { MOD_PRESENCE_STATE_ENUM } from "./module-ids.ts";
import { reachModule } from "./reach.ts";

/**
 * Presence-state enum — chat module 46471 exports this as `O`. Backs the
 * presence slice's `awayState` slot. Confirmed members + values from the
 * factory body (`{Present: 0, Away: 1, AwaitingReactivate: 2}`).
 *
 * The bundle's gate on `broadcastTypingActivity` compares
 * `state.presence.awayState === O.Present`, so anything that suppresses
 * typing pulses across the wire flows from this enum.
 *
 * Lives here (not in `bundle/types.ts`) because the only consumers are
 * the registry getter `presenceStateEnum()` below and `client.ts`'s
 * `setStatus`/`getStatus` mapping — keeping the type co-located with its
 * one bundle-side getter avoids a cross-file rename when Snap changes
 * the enum shape.
 *
 * @internal Bundle wire-format type.
 */
export interface PresenceStateEnum {
  /** Active / present — typing-pulse + presence broadcasts are gated open. */
  Present: number;
  /** Idle / away — bundle suppresses typing pulses. */
  Away: number;
  /** Transitional — awaiting client-side reactivation, rare. */
  AwaitingReactivate: number;
}

/**
 * Presence slice — Zustand store on chat module 94704 (factory `Zn(set,get)`
 * at chat main byte ~8310100).
 *
 * Drives the presence-layer surface the bundle's modern chat clients gate
 * typing / viewing indicators on. The sister convMgr path
 * (`convMgr.sendTypingNotification` etc.) leaves a WS frame on the wire
 * but the recipient's UI ignores it unless the presence session has been
 * primed via `createPresenceSession(convId)` + `presenceSession.onUserAction
 * ({type: "chatVisible"})`.
 *
 * Methods:
 *   - {@link PresenceSlice.initializePresenceServiceTs} — one-shot init
 *     with our duplex bridge (see `bundle/presence-bridge.ts`).
 *   - {@link PresenceSlice.createPresenceSession} — per-conv session;
 *     populates `state.presence.presenceSession` (single-slot).
 *   - {@link PresenceSlice.broadcastTypingActivity} — broadcasts a
 *     "typing" pulse on the active session.
 *   - {@link PresenceSlice.setAwayState} — Present / Away enum value.
 *
 * @internal Bundle-layer accessor. Public consumers reach presence via
 * `Messaging.setTyping` / `Messaging.setViewing` (see `src/api/messaging.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `presence` slice from the chat-bundle state
 */
export const presenceSlice = (sandbox: Sandbox): PresenceSlice =>
  (chatStore(sandbox).getState() as ChatState).presence;

/**
 * Presence-state enum — chat module 46471, exporting `O` as
 * `{Present: 0, Away: 1, AwaitingReactivate: 2}`.
 *
 * The numeric values back the presence slice's `awayState` slot: the
 * slice initializes from `document.hasFocus() ? O.Present : O.Away` at
 * factory time, and subsequent reads/writes (`presenceSlice.setAwayState`,
 * the `broadcastTypingActivity` gate) compare against these enum values.
 *
 * Reaching the enum live (rather than hardcoding the integers in
 * consumer-side code) means the SDK keeps working if Snap renumbers the
 * enum members in a future bundle build — only this one constant mapper
 * needs verification on remap.
 *
 * @internal Bundle-layer accessor. Public consumers reach presence state
 * via `SnapcapClient.setStatus` / `getStatus` (see `src/client.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `O` enum object from chat module 46471
 */
export const presenceStateEnum = (sandbox: Sandbox): PresenceStateEnum =>
  reachModule<{ O: PresenceStateEnum }>(sandbox, MOD_PRESENCE_STATE_ENUM, "presenceStateEnum").O;
