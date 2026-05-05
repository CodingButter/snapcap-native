/**
 * Shared helpers for the api layer.
 *
 * These are the small adaptation primitives that every api file needs to
 * convert between consumer-facing shapes (UUID strings, plain numbers,
 * Date objects) and the bundle-shaped types declared in `../bundle/types.ts`
 * (16-byte UUID buffers, `{highBits, lowBits}` pairs, bigints, enum ints).
 *
 * @remarks
 * The bundle registry (`../bundle/register/`) is intentionally pure
 * pass-through to Snap's webpack methods — every export there takes
 * bundle-realm types in and returns bundle-realm types out. The api
 * files own the consumer-friendly surface and lean on these helpers to
 * bridge the two sides.
 *
 * Conventions:
 *   - Each helper is a small named export. No default export.
 *   - Helpers are stateless and synchronous unless explicitly noted.
 *   - Bundle-shape types are imported from `../bundle/types.ts`; numeric
 *     primitives are inferred.
 *
 * The four UUID primitives ({@link uuidToBytes}, {@link bytesToUuid},
 * {@link uuidToHighLow}, {@link highLowToUuid}) are re-exported as part
 * of the public SDK surface; the remaining helpers are SDK-internal
 * (used by the api layer to bridge bundle-shape parameters into the
 * registry).
 */
import type { DecodedSearchUserResult, Uuid64Pair } from "../bundle/types/index.ts";

/**
 * Convert a hyphenated UUID string into its 16-byte representation.
 *
 * Snap uses these for `conversationId`, `userId`, and other identity
 * fields embedded in messaging RPCs. Most of Snap's gRPC schemas wrap
 * the bytes in a single-field message (`{ id: bytes }`) — call sites
 * typically need the raw 16 bytes here and let the bundle add the
 * wrapper.
 *
 * @param uuid - Hyphenated UUID string (e.g. `"527be2ff-aaec-4622-9c68-79d200b8bdc1"`).
 * @returns 16-byte big-endian buffer.
 * @throws If `uuid` isn't a valid hyphenated UUID (32 hex chars after
 * hyphens are stripped).
 *
 * @example
 * ```ts
 * uuidToBytes("527be2ff-aaec-4622-9c68-79d200b8bdc1");
 * // → Uint8Array(16) [0x52, 0x7b, 0xe2, 0xff, ...]
 * ```
 *
 * @see {@link bytesToUuid}
 */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`invalid UUID: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Inverse of {@link uuidToBytes}: 16-byte buffer → hyphenated UUID string.
 *
 * @param bytes - 16-byte buffer.
 * @returns Hyphenated UUID string.
 * @throws If `bytes.byteLength !== 16`.
 *
 * @see {@link uuidToBytes}
 */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) {
    throw new Error(`expected 16 bytes for UUID, got ${bytes.byteLength}`);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Split a UUID into the `{high, low}` fixed64 pair Snap uses in some RPCs
 * (e.g. `FriendAction.AddFriends`) instead of the bytes16 wrapper.
 *
 * @param uuid - Hyphenated UUID string.
 * @returns `{ high, low }` — `high` is the big-endian uint64 of UUID
 * bytes 0..7, `low` is the big-endian uint64 of bytes 8..15.
 *
 * @see {@link highLowToUuid}
 */
export function uuidToHighLow(uuid: string): { high: bigint; low: bigint } {
  const bytes = uuidToBytes(uuid);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { high: dv.getBigUint64(0, false), low: dv.getBigUint64(8, false) };
}

/**
 * Inverse of {@link uuidToHighLow}: assemble a UUID string from the
 * `{high, low}` pair.
 *
 * @param high - Upper 64 bits as `bigint` or decimal-string.
 * @param low - Lower 64 bits as `bigint` or decimal-string.
 * @returns Hyphenated UUID string.
 *
 * @see {@link uuidToHighLow}
 */
export function highLowToUuid(high: bigint | string, low: bigint | string): string {
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, typeof high === "bigint" ? high : BigInt(high), false);
  dv.setBigUint64(8, typeof low === "bigint" ? low : BigInt(low), false);
  return bytesToUuid(out);
}

/**
 * UUID-string → `{highBits, lowBits}` 64-bit pair — the convention used by
 * Snap's friending protos (`AddFriends`, `RemoveFriends`, etc.).
 *
 * Returns the bigints stringified, which is what the bundle's ts-proto
 * codecs accept at `fromPartial` time and what the SPA itself sends.
 *
 * @param uuid - Hyphenated UUID string.
 * @returns `{ highBits, lowBits }` decimal-string pair.
 *
 * @internal
 */
export function uuidToHighLowPair(uuid: string): Uuid64Pair {
  const { high, low } = uuidToHighLow(uuid);
  return { highBits: high.toString(), lowBits: low.toString() };
}

/**
 * Build a list of `Uuid64Pair`-wrapped `friendId` params for the
 * friend-mutation request shapes (`RemoveFriends`, `BlockFriends`, etc.).
 *
 * Most of those methods accept `{page?, params: [{friendId: Uuid64Pair}]}`
 * — this helper handles the per-id wrapping in one place.
 *
 * @param userIds - Hyphenated UUID strings.
 * @param source - Optional `FriendSource` enum value used by `AddFriends`
 * (and `InviteFriends`) — the only mutation verbs that carry source
 * attribution. Pass `undefined` (the default) for verbs that don't
 * accept a source field; the param is omitted from the entry.
 * @returns Per-id wrapped params array.
 *
 * @internal
 */
export function makeFriendIdParams(
  userIds: string[],
  source?: number,
): Array<{ friendId: Uuid64Pair; source?: number }> {
  return userIds.map((u) =>
    source === undefined
      ? { friendId: uuidToHighLowPair(u) }
      : { friendId: uuidToHighLowPair(u), source },
  );
}

/**
 * Pull a hyphenated-UUID userId out of whatever shape the search-result
 * `user` field decoded into.
 *
 * Bundle codecs may decode the `id` slot as either a `Uuid64Pair`
 * (`highBits`/`lowBits`) or a 16-byte buffer; the top-level `userId`
 * string is sometimes set instead. Returns `""` when none of those are
 * present.
 *
 * @param u - Decoded search-user result (bundle shape).
 * @returns Hyphenated UUID string, or `""` if no recognizable id form is
 * present.
 *
 * @remarks
 * Cross-cutting: lives here (not in `friends.ts`) because future managers
 * (Messaging, Presence) will hit the same UUID-shape variations from
 * their own bundle records.
 *
 * @internal
 */
export function extractUserId(u: DecodedSearchUserResult): string {
  if (typeof u.userId === "string" && u.userId.length > 0) return u.userId;
  const id = u.id;
  if (!id) return "";
  // Bundle's search/user codec emits a hyphenated UUID string in `id`.
  if (typeof id === "string") return id;
  if (id instanceof Uint8Array) return id.byteLength === 16 ? bytesToUuid(id) : "";
  if (typeof id === "object" && "highBits" in id && "lowBits" in id) {
    try {
      const hi = BigInt(id.highBits as bigint | string);
      const lo = BigInt(id.lowBits as bigint | string);
      const buf = new Uint8Array(16);
      const dv = new DataView(buf.buffer);
      dv.setBigUint64(0, hi, false);
      dv.setBigUint64(8, lo, false);
      return bytesToUuid(buf);
    } catch {
      return "";
    }
  }
  return "";
}
