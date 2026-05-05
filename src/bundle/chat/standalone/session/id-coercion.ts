/**
 * UUID ↔ 16-byte cross-realm conversion helpers.
 *
 * The bundle's WASM hands us conversation / message IDs in three flavours:
 *   - `Uint8Array(16)` from the standalone realm's typed-array constructor
 *   - `{0:n, 1:n, ..., 15:n, byteLength:16}` cross-realm dictionary shape
 *   - hyphenated UUID strings (rare, mostly from log paths)
 *
 * Outbound UUID strings get re-encoded as 16-byte buffers in the SAME
 * realm Embind expects. Cross-realm `instanceof Uint8Array` checks fail,
 * so we always allocate via the passed `VmU8` constructor.
 *
 * @internal
 */

/**
 * Convert UUID string ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") to 16 bytes
 * in the given realm's `Uint8Array`. Strict — throws when the input isn't
 * exactly 32 hex chars (use {@link uuidStringToBytes16} for the loose
 * variant).
 */
export function uuidToBytes16(uuid: string, VmU8: Uint8ArrayConstructor): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`uuidToBytes16: expected 32 hex chars, got ${hex.length} for "${uuid}"`);
  }
  const out = new VmU8(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Loose UUID → 16-byte realm-Uint8Array. Returns a padded best-effort
 * decode if the input isn't UUID-shaped (Snap sometimes emits ids that
 * miss separators or vary in case).
 */
export function uuidStringToBytes16(uuid: string, VmU8: Uint8ArrayConstructor): Uint8Array {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    // Best-effort — pad / truncate to 16 bytes worth of hex.
    const padded = (hex + "00000000000000000000000000000000").slice(0, 32);
    const out = new VmU8(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  }
  const out = new VmU8(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Coerce one of the bundle's Embind ID shapes to a realm-local 16-byte
 * `Uint8Array`. Embind hands us either:
 *   - `{ id: Uint8Array(16) }` (most common — e.g. `conversationId` on
 *     `conversationMetricsData`)
 *   - `{ id: { 0:n, 1:n, …, 15:n, byteLength:16 } }` (cross-realm shape
 *     where the inner Uint8Array's prototype isn't ours)
 *   - a bare 16-byte `Uint8Array`
 *   - a UUID string (rare but possible)
 *
 * Returns `undefined` if none of the above produce 16 bytes.
 */
export function coerceIdBytes(
  v: unknown,
  VmU8: Uint8ArrayConstructor,
): Uint8Array | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    return uuidStringToBytes16(v, VmU8);
  }
  // Walk one or two levels to find a 16-byte buffer.
  const tryRead = (b: unknown): Uint8Array | undefined => {
    if (!b) return undefined;
    if (b instanceof Uint8Array && b.byteLength === 16) {
      const out = new VmU8(16);
      out.set(b);
      return out;
    }
    if (typeof b === "object") {
      const o = b as { byteLength?: number; [k: number]: number };
      if (o.byteLength === 16) {
        const out = new VmU8(16);
        for (let i = 0; i < 16; i++) out[i] = o[i] ?? 0;
        return out;
      }
    }
    return undefined;
  };
  const direct = tryRead(v);
  if (direct) return direct;
  const inner = (v as { id?: unknown }).id;
  return tryRead(inner);
}

/**
 * Convert a 16-byte UUID byte array (from Embind) back into a hyphenated
 * UUID string. Cross-realm safe: walks indexable shapes rather than
 * relying on `instanceof Uint8Array`.
 *
 * Returns `undefined` for inputs that aren't exactly 16 bytes.
 */
export function bytesToUuidString(b: unknown): string | undefined {
  if (!b) return undefined;
  // Walk to a 16-byte indexable — handles real Uint8Array, cross-realm
  // typed array, plain {0,1,...,15,byteLength:16}, or an array.
  const o = b as { byteLength?: number; length?: number; [k: number]: number };
  const n = o.byteLength ?? o.length ?? 0;
  if (n !== 16) return undefined;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    const v = (o[i] ?? 0) & 0xff;
    hex.push(v.toString(16).padStart(2, "0"));
  }
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
