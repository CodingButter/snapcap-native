/**
 * Convert a bundle-realm messaging-delegate callback argument into the
 * SDK-shaped {@link PlaintextMessage} and forward it to the consumer's
 * `onPlaintext` handler.
 *
 * Cross-realm safety matters — the WASM hands us `Uint8Array` instances
 * whose prototype lives in the standalone realm, so naked `instanceof
 * Uint8Array` checks fail. We probe via `constructor.name` and copy the
 * bytes into a host-realm Uint8Array before surfacing.
 *
 * @internal
 */
import type { PlaintextMessage } from "./types.ts";
import { bytesToUuidString } from "./id-coercion.ts";
import { safeStringifyVal } from "./utils.ts";

/**
 * Extract `t.content` (the WASM's plaintext bytes) from a messaging
 * delegate callback's argument and forward to the consumer's
 * `onPlaintext`. Cross-realm safe: identifies `Uint8Array` by
 * `constructor.name` instead of `instanceof`.
 *
 * Skips the callback when content is missing (logs `PLAIN.skip` with the
 * `decryptFailureReason` for diagnostics) or when bytes is empty.
 */
export function deliverPlaintext(
  m: unknown,
  onPlaintext: (msg: PlaintextMessage) => void,
  log: (line: string) => void,
): void {
  if (!m || typeof m !== "object") return;
  const obj = m as Record<string, unknown>;
  const content = obj.content;
  const isSender = obj.isSender as boolean | undefined;
  const contentType = obj.contentType as number | undefined;
  if (!content) {
    // Compact diagnostic: helps catch decrypt regressions (CEK_ENTRY_NOT_FOUND
    // would mean every inbound message lands here with empty content).
    const dfr = obj.decryptFailureReason;
    log(
      `PLAIN.skip: ct=${contentType} isSender=${isSender} decryptFailureReason=${safeStringifyVal(dfr)}`,
    );
    return;
  }

  // Cross-realm Uint8Array detection. Embind hands us one of:
  //   - sandbox-realm Uint8Array (constructor.name === "Uint8Array")
  //   - host-realm Uint8Array (instanceof passes)
  //   - host-realm number[] (rare with Embind <vector<uint8_t>>)
  let bytes: Uint8Array | undefined;
  if (content instanceof Uint8Array) {
    bytes = content;
  } else if (
    content &&
    typeof content === "object" &&
    (content as { constructor?: { name?: string } }).constructor?.name === "Uint8Array"
  ) {
    const c = content as { byteLength: number; [k: number]: number };
    bytes = new Uint8Array(c.byteLength);
    for (let i = 0; i < c.byteLength; i++) bytes[i] = c[i] ?? 0;
  } else if (Array.isArray(content)) {
    bytes = new Uint8Array(content as number[]);
  }

  if (!bytes || bytes.byteLength === 0) return;

  // Surface a hyphenated conversationId on `raw` so consumers can filter
  // without re-decoding the embedded ID-bytes object. The WASM hands us
  // either a top-level `conversationId: { id: Uint8Array(16) }` (live
  // push) or only `conversationMetricsData.conversationId: { id: ... }`
  // (some history paths). Normalize both into `raw.conversationId` as
  // a UUID string while leaving the original obj keys intact for callers
  // that want the raw shape.
  const ridTop = (obj.conversationId as { id?: unknown } | undefined)?.id;
  const md = obj.conversationMetricsData as { conversationId?: unknown } | undefined;
  const ridMd = (md?.conversationId as { id?: unknown } | undefined)?.id;
  const ridBytes = ridTop ?? ridMd;
  let convIdStr: string | undefined;
  if (ridBytes) {
    convIdStr = bytesToUuidString(ridBytes);
  }
  const rawOut: Record<string, unknown> = { ...obj };
  if (convIdStr && !rawOut.conversationId) {
    rawOut.conversationId = convIdStr;
  } else if (convIdStr && rawOut.conversationId && typeof rawOut.conversationId === "object") {
    // Bundle hands us `{ id: bytes }`; promote a sibling string field for
    // simple filtering. Keep the original object under `conversationIdRaw`.
    rawOut.conversationIdRaw = rawOut.conversationId;
    rawOut.conversationId = convIdStr;
  }

  if (process.env.SNAPCAP_DEBUG_WORKER) {
    log(
      `[deliver] bytes=${bytes.byteLength} convId=${convIdStr ?? "?"} ct=${contentType} isSender=${isSender}`,
    );
  }

  onPlaintext({ content: bytes, isSender, contentType, raw: rawOut });
}
