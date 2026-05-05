/**
 * Post-`createMessagingSession` wake-up pulses.
 *
 * The bundle's chunk does this sequence immediately after
 * `messaging_Session.create` returns; we mirror it here because we drive
 * the create call ourselves rather than letting the chunk do it.
 *
 * ## Why each pulse matters
 *
 * **`reachabilityChanged(true)` + `appStateChanged(ACTIVE)`** —
 * Per bundle source (byte 63300), the chunk does these immediately after
 * `messaging_Session.create` returns. They wake the messaging session
 * into the ACTIVE state. Without them the session stays INACTIVE and
 * the WASM routes message-decrypt results to the analytics path only,
 * suppressing delivery via the messagingDelegate. Symptom: RECEIVE_MESSAGE
 * analytics events fire for new messages but `onMessageReceived` /
 * `onMessagesReceived` hooks stay silent.
 *
 * `o.tq` enum values (best guess; bundle uses ACTIVE=0, BACKGROUND=1):
 * `ACTIVE = 0`, `BACKGROUND = 1`, `INACTIVE = 2` — try in order.
 *
 * **`sync_trigger` no-op handler** —
 * The bundle's React layer normally registers a `"sync_trigger"` duplex
 * handler that, on each pushed payload, calls back into the WASM's sync
 * routines (which surface new messages via the messaging delegate).
 * Without it, the WS receives push frames for that path and the duplex
 * client drops them with `reason="no_handler"`, so live inbound stays
 * silent until polling-triggered DeltaSync stumbles across them. The
 * sole purpose of our no-op is to STOP that drop; the actual sync
 * side-effect happens in the WASM independently.
 *
 * **`onNetworkStatusChange("BROWSER_ONLINE")`** —
 * Snap's `sr` class is NOT a BehaviorSubject; subscribers only fire on
 * `.next()`, never on the initial value. The duplex client subscribes
 * during `fn()`'s first invocation but at that point the observable's
 * current value (BROWSER_ONLINE) is silent. A `.next()` call after
 * subscription re-runs the duplex client's online branch, which can
 * re-arm the WS read loop on builds where `init()` didn't auto-open it.
 *
 * @internal
 */

type EnEngineLike = {
  onNetworkStatusChange?: (status: string) => void;
  registerDuplexHandler?: (
    path: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
  ) => unknown;
};

/**
 * Run the wake-up sequence in the order documented above. Each step
 * tolerates failure independently — Embind enum bindings shift across
 * builds and the priority is "wake whatever you can".
 */
export function wakeSession(opts: {
  session: Record<string, Function>;
  En: EnEngineLike;
  log: (line: string) => void;
}): void {
  const { session, En, log } = opts;
  const sessAny = session as Record<string, Function>;

  if (typeof sessAny.reachabilityChanged === "function") {
    try {
      sessAny.reachabilityChanged(true);
    } catch (e) {
      log(`[wakeSession] reachabilityChanged threw ${(e as Error).message?.slice(0, 200)}`);
    }
  }
  if (typeof sessAny.appStateChanged === "function") {
    // Try ACTIVE=0 first; if Embind enum binding rejects, fall through.
    for (const v of [0, 1, 2]) {
      try {
        sessAny.appStateChanged(v);
        break;
      } catch {
        /* try next */
      }
    }
  }

  if (typeof En.registerDuplexHandler === "function") {
    try {
      En.registerDuplexHandler("sync_trigger", { onReceive: (_bytes: Uint8Array) => {} });
    } catch (e) {
      log(
        `[wakeSession] registerDuplexHandler("sync_trigger") threw: ${(e as Error).message?.slice(0, 200)}`,
      );
    }
  }

  if (typeof En.onNetworkStatusChange === "function") {
    try {
      En.onNetworkStatusChange("BROWSER_ONLINE");
    } catch (e) {
      log(`[wakeSession] onNetworkStatusChange threw: ${(e as Error).message?.slice(0, 200)}`);
    }
  }
}
