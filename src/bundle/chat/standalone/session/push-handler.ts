/**
 * Push-message handling: route inbound delegate callbacks to either the
 * direct cached-history path (when bytes already populated) or the
 * live-WS-push fallback path (which re-invokes the conversation manager
 * to re-decrypt on the WASM side).
 *
 * Returns three closures that share state — the captured session ref
 * (set after `createMessagingSession` resolves) and the analytics-id
 * dedupe set (so WS retry frames don't fan out into repeated
 * `fetchConversationWithMessages` calls).
 *
 * @internal
 */
import type { PlaintextMessage } from "./types.ts";
import { coerceIdBytes } from "./id-coercion.ts";
import { deliverPlaintext } from "./deliver-plaintext.ts";
import { safeStringifyVal } from "./utils.ts";

/**
 * Per-session push-handler factory. Returns:
 *
 *   - `handlePushMessage(m)`: dispatch a delegate callback's argument —
 *     deliver in-place if `m.content` is populated (cached history),
 *     else trigger {@link fetchPushBody}.
 *   - `fetchPushBody(obj)`: call into the bundle's
 *     `convMgr.fetchConversationWithMessages` to re-decrypt the conv.
 *   - `setSession(s)`: invoked by `setup.ts` once
 *     `createMessagingSession` resolves; until then, push events are
 *     dropped on the floor.
 */
export function createPushHandler(opts: {
  onPlaintext: (msg: PlaintextMessage) => void;
  log: (line: string) => void;
  /** Standalone-realm Uint8Array constructor — used to project ids. */
  VmU8: Uint8ArrayConstructor;
}): {
  handlePushMessage: (m: unknown) => void;
  setSession: (s: Record<string, Function>) => void;
} {
  const { onPlaintext, log, VmU8 } = opts;
  // Hold a session reference for the live-push fetch path. Captured the
  // first time createMessagingSession resolves; the wrapped delegate
  // hooks reach for it to call cm.fetchMessage by analyticsMessageId.
  let capturedSession: Record<string, Function> | undefined;
  // Dedupe analyticsMessageId fetches — the WS push fires the same id
  // multiple times per delivery (analytics retry, batch echoes, etc.).
  const fetchedAnalyticsIds = new Set<string>();

  // Live-push body fetch. Snap's messaging delegate fires with empty
  // `content` for live WS push — the analytics-style record carries
  // metadata only (analyticsMessageId / conversationMetricsData /
  // decryptResult). The actual decrypted body is reachable via the
  // bundle's `convMgr.fetchMessage(...)` / `fetchMessageByServerId(...)`
  // — the same call Snap's web UI uses to render the message body after
  // a push notification. We deduplicate per analyticsMessageId so the
  // WS retry frames don't fire repeated fetches.
  const fetchPushBody = (obj: Record<string, unknown>): void => {
    if (!capturedSession) return; // session not yet ready — drop
    const cm = (capturedSession.getConversationManager as Function | undefined)?.();
    if (!cm) return;
    const cmAny = cm as Record<string, Function>;

    // Pull conversationId from conversationMetricsData.conversationId.
    const cmd = obj.conversationMetricsData as { conversationId?: unknown } | undefined;
    const convIdAny = cmd?.conversationId;
    const convIdBytes = coerceIdBytes(convIdAny, VmU8);
    if (!convIdBytes) return;

    // Pull message identifier. The analytics record carries
    // `analyticsMessageId` as a UUID string (e.g.
    // "00000000-0000-0008-AB17-E6B2F4F7DD75") — the high 8 bytes encode
    // the server message id, low 8 bytes are conv-id-tail. Use the
    // attemptId (a 16-byte client UUID) as the dedupe key + raw id.
    const aid = obj.analyticsMessageId;
    const dedupeKey =
      typeof aid === "string" ? aid : safeStringifyVal(aid).slice(0, 80);
    if (fetchedAnalyticsIds.has(dedupeKey)) return;
    fetchedAnalyticsIds.add(dedupeKey);
    // Cap dedupe set so we don't grow unboundedly.
    if (fetchedAnalyticsIds.size > 5000) {
      const first = fetchedAnalyticsIds.values().next().value as string | undefined;
      if (first) fetchedAnalyticsIds.delete(first);
    }

    // Strategy: trigger `fetchConversationWithMessages` on the conv. The
    // bundle's WASM re-decrypts that conv's recent messages and re-fires
    // OUR ALREADY-WRAPPED `messagingDelegate.onMessagesReceived` with
    // populated `m.content` — same callback the cached-history path uses
    // at session start. We don't need a separate callback wrapper here;
    // the existing wrap surfaces decrypted content via deliverPlaintext
    // automatically.
    //
    // (Earlier we tried `fetchMessage(convId, aid, cb)` directly but the
    // bundle's signature wants an int64 server message id, not the
    // analytics UUID — wrong shape, threw repeatedly. The conv-level
    // re-fetch is simpler and uses the path we already proved works.)
    if (typeof cmAny.fetchConversationWithMessages === "function") {
      try {
        cmAny.fetchConversationWithMessages(
          { id: convIdBytes },
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
              log(`[fetchPushBody.onError] ${safeStringifyVal(a).slice(0, 200)}`),
          },
        );
      } catch (e) {
        log(`[fetchPushBody] threw ${(e as Error).message?.slice(0, 200)}`);
      }
    }
  };

  // Push-path handler: deliver if the delegate already carries plaintext
  // (cached history surfaces with `m.content` populated), otherwise pull
  // the body from the bundle by analyticsMessageId via cm.fetchMessage —
  // the bundle's WASM runs the Fidelius decrypt + cleartext-body lookup
  // and hands us the unified plaintext message proto.
  const handlePushMessage = (m: unknown): void => {
    if (!m || typeof m !== "object") return;
    const obj = m as Record<string, unknown>;
    const content = obj.content;
    const hasBytes = !!(content && (content as Uint8Array).byteLength > 0);
    if (process.env.SNAPCAP_DEBUG_WORKER) {
      const keys = Object.keys(obj).slice(0, 30).join(",");
      const cid = (obj.conversationId as { id?: unknown })?.id ?? obj.conversationId;
      const md = obj.conversationMetricsData as { conversationId?: unknown } | undefined;
      const cidFromMd = (md?.conversationId as { id?: unknown })?.id ?? md?.conversationId;
      log(
        `[handlePush] hasBytes=${hasBytes} cid=${safeStringifyVal(cid).slice(0, 60)} cidMd=${safeStringifyVal(cidFromMd).slice(0, 60)} keys=${keys}`,
      );
    }
    if (hasBytes) {
      // Cached history path — the analytics-style record actually carries
      // plaintext bytes already. Surface verbatim.
      deliverPlaintext(m, onPlaintext, log);
      return;
    }
    // Live-push notification with empty content. Resolve via convMgr.
    fetchPushBody(obj);
  };

  return {
    handlePushMessage,
    setSession: (s: Record<string, Function>): void => {
      capturedSession = s;
    },
  };
}
