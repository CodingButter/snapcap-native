/**
 * Pump the inbox: enter the conversations the caller asked about, and
 * fetch their decrypted history through the wrapped messagingDelegate.
 *
 * Strategy:
 *   - DeltaSync runs continuously after createMessagingSession via the
 *     bundle's own duplex client; it pulls new content into the WASM's
 *     internal cache.
 *   - `enterConversation` marks a conv "active" and biases live delivery
 *     toward that conv. Enter the TARGET (priority) conv LAST so it
 *     stays active during the wait window.
 *   - `fetchConversationWithMessages` reads the WASM's current conv
 *     state and surfaces history through the messagingDelegate hook.
 *
 * @internal
 */
import type { PlaintextMessage } from "./types.ts";
import { uuidToBytes16 } from "./id-coercion.ts";
import { deliverPlaintext } from "./deliver-plaintext.ts";
import { safeStringifyVal } from "./utils.ts";

/**
 * Walk the caller's `conversationIds` list, fetch each conv's history,
 * then enter them in the order documented above. No-op when
 * `conversationIds` is empty.
 */
export function pumpInbox(opts: {
  session: Record<string, Function>;
  conversationIds: readonly string[];
  onPlaintext: (msg: PlaintextMessage) => void;
  log: (line: string) => void;
  /** Standalone-realm Uint8Array — for cross-realm conv-id projection. */
  VmU8: Uint8ArrayConstructor;
}): void {
  const { session, conversationIds, onPlaintext, log, VmU8 } = opts;
  if (conversationIds.length === 0) return;
  const targetConvId = conversationIds[0]; // caller convention: priority conv first

  try {
    const cm = (session.getConversationManager as Function)?.() as
      | Record<string, Function>
      | undefined;
    if (!cm) return;

    if (process.env.SNAPCAP_PROBE_CONVMGR) {
      // One-shot introspection — print every method on convMgr and a
      // .toString() of the candidates we suspect.
      const allKeys: string[] = [];
      let proto: object | null = cm as unknown as object;
      while (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
          if (typeof (cm as Record<string, unknown>)[k] === "function") allKeys.push(k);
        }
        proto = Object.getPrototypeOf(proto);
      }
      log(`[probe] convMgr keys: ${Array.from(new Set(allKeys)).sort().join(", ")}`);
      for (const k of [
        "fetchMessage",
        "fetchMessageByServerId",
        "fetchMessagesByServerIds",
        "fetchServerMessageIdentifier",
        "fetchMessageForQuotedView",
        "fetchMessages",
      ]) {
        const fn = (cm as Record<string, unknown>)[k];
        if (typeof fn === "function") {
          log(`[probe] cm.${k}.toString = ${(fn as Function).toString().slice(0, 200)}`);
          log(`[probe] cm.${k}.length = ${(fn as Function).length}`);
        }
      }
    }

    // History-fetch every conv first — surfaces decrypted messages
    // through the wrapped messagingDelegate.onMessagesReceived hook.
    for (const convId of conversationIds) {
      const idBytes = uuidToBytes16(convId, VmU8);
      if (typeof cm.fetchConversationWithMessages === "function") {
        try {
          cm.fetchConversationWithMessages(
            { id: idBytes },
            {
              onFetchConversationWithMessagesComplete: (
                _conv: unknown,
                messages: unknown,
                _hasMore: unknown,
              ) => {
                if (Array.isArray(messages)) {
                  for (const m of messages) deliverPlaintext(m, onPlaintext, log);
                }
              },
              onError: (...a: unknown[]) =>
                log(`[fetchConvMsgs.${convId}] onError ${safeStringifyVal(a).slice(0, 200)}`),
            },
          );
        } catch (e) {
          log(`[fetchConvMsgs.${convId}] threw ${(e as Error).message?.slice(0, 200)}`);
        }
      }
    }

    // Enter NON-target convs first; target LAST so it stays active.
    if (typeof cm.enterConversation === "function") {
      const enterOrder: string[] = [];
      for (const c of conversationIds) if (c !== targetConvId) enterOrder.push(c);
      if (targetConvId) enterOrder.push(targetConvId);
      for (const convId of enterOrder) {
        const idBytes = uuidToBytes16(convId, VmU8);
        try {
          cm.enterConversation({ id: idBytes }, 0, {
            onSuccess: () => {},
            onError: (...a: unknown[]) =>
              log(`[enterConversation] onError ${safeStringifyVal(a).slice(0, 200)}`),
          });
        } catch (e) {
          log(`[enterConversation] threw ${(e as Error).message?.slice(0, 200)}`);
        }
      }
    }
  } catch (e) {
    log(`[setupBundleSession] manager probe err: ${(e as Error).message}`);
  }
}
