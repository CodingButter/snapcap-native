/**
 * Wrap `Module.messaging_Session.create` to hook the messagingDelegate
 * (arg slot 9) so plaintext lands in the consumer's `onPlaintext`.
 *
 * Per recovered v3 reverse-engineering, slot 9 of `Sess.create` is the
 * messagingDelegate. The chunk's own wrapper at that slot routes
 * analytics (`cn(e, [msg])`); we wrap it on top so plaintext lands in
 * the consumer's onPlaintext.
 *
 * Slot 9 can be EITHER a factory (`function(e){return {onMessageReceived: ...}}`,
 * which is what the bundle's chunk passes — Embind invokes the factory
 * with a session-context arg and uses the returned object) OR a plain
 * delegate object (callers that pre-build the delegate). We handle both
 * shapes by wrapping the relevant `onMessageReceived` /
 * `onMessagesReceived` slots.
 *
 * @internal
 */
import type { EmModule } from "./types.ts";

/**
 * Install the slot-9 wrap. Captures `sessionStartMs` at install time so
 * the diagnostic timestamps in the wrapped delegate's logs are relative
 * to bring-up.
 */
export function wrapSessionCreate(opts: {
  Module: EmModule;
  /** Forwarded plaintext sink — invoked from the wrapped delegate. */
  handlePushMessage: (m: unknown) => void;
  log: (line: string) => void;
}): void {
  const { Module, handlePushMessage, log } = opts;
  const SessAny = (Module as Record<string, unknown>).messaging_Session as
    & (new (...a: unknown[]) => unknown)
    & Record<string, unknown>;
  const Sess = SessAny as unknown as Record<string, Function>;
  if (typeof Sess.create !== "function") {
    throw new Error("setupBundleSession: Module.messaging_Session.create not a function");
  }
  const origCreate = Sess.create.bind(Sess);
  const sessionStartMs = Date.now();

  // Factory-wrapper builder. Slot 9 of messaging_Session.create can be
  // either a FACTORY (`function(e){return {onMessageReceived: ...}}`,
  // which is what the bundle's chunk passes — Embind invokes the factory
  // with a session-context arg and uses the returned object) or a plain
  // delegate object (callers that pre-build the delegate). We handle both
  // shapes by wrapping the relevant onMessageReceived / onMessagesReceived
  // slots so plaintext lands in `opts.onPlaintext`.
  const buildHookedDelegate = (orig: Record<string, unknown>): Record<string, unknown> => {
    const origOnMR = (orig.onMessageReceived as Function | undefined)?.bind(orig);
    const origOnMsR = (orig.onMessagesReceived as Function | undefined)?.bind(orig);
    return {
      ...orig,
      onMessageReceived: (t: unknown) => {
        if (process.env.SNAPCAP_DEBUG_WORKER) {
          const elapsed = Date.now() - sessionStartMs;
          const obj = t as Record<string, unknown>;
          log(
            `[hook.onMessageReceived] @${elapsed}ms isSender=${obj?.isSender} ct=${obj?.contentType} hasContent=${!!obj?.content}`,
          );
        }
        if (process.env.SNAPCAP_PROBE_CONVMGR && t && typeof t === "object") {
          const obj = t as Record<string, unknown>;
          // Lazy import to avoid pulling utils into the hot path
          const safeStringifyVal = (v: unknown): string => {
            try {
              return JSON.stringify(v, (_k, vv) =>
                typeof vv === "bigint" ? vv.toString() + "n" : vv,
              );
            } catch {
              return "[unserial]";
            }
          };
          log(
            `[probe.t] keys=${Object.keys(obj).join(",")} sample=${safeStringifyVal(obj).slice(0, 400)}`,
          );
        }
        handlePushMessage(t);
        try {
          origOnMR?.(t);
        } catch (e) {
          log(`[hook.onMessageReceived] orig threw ${(e as Error).message}`);
        }
      },
      onMessagesReceived: (ts: unknown) => {
        if (process.env.SNAPCAP_DEBUG_WORKER) {
          const elapsed = Date.now() - sessionStartMs;
          log(
            `[hook.onMessagesReceived] @${elapsed}ms len=${Array.isArray(ts) ? ts.length : "?"}`,
          );
        }
        if (Array.isArray(ts)) {
          for (const m of ts) handlePushMessage(m);
        }
        try {
          origOnMsR?.(ts);
        } catch (e) {
          log(`[hook.onMessagesReceived] orig threw ${(e as Error).message}`);
        }
      },
    };
  };

  Sess.create = function patchedCreate(...a: unknown[]) {
    const slot9 = a[9];
    if (typeof slot9 === "function") {
      // Factory: wrap so we hook the delegate the factory returns.
      const origFactory = slot9 as (...fargs: unknown[]) => unknown;
      a[9] = (...fargs: unknown[]) => {
        const built = origFactory(...fargs);
        if (built && typeof built === "object") {
          return buildHookedDelegate(built as Record<string, unknown>);
        }
        return built;
      };
    } else if (slot9 && typeof slot9 === "object") {
      a[9] = buildHookedDelegate(slot9 as Record<string, unknown>);
    }
    return origCreate(...a);
  };
}
