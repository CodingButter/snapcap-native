/**
 * Minimal proto3 wire-format encoder.
 *
 * Snap's bundle ships full protobufjs encoders for every message it knows
 * about, but a few we want (typing, conversation update, content-message
 * update) live in lazy-loaded chunks we don't pre-fetch. Rather than force
 * those chunks to load at boot, we hand-encode the request bodies here.
 *
 * Wire format reference: https://protobuf.dev/programming-guides/encoding/
 *
 * Supports just enough of the spec to serialize the messaging requests:
 *   - varint  (wire type 0)  — for int32, int64, enums, length prefixes
 *   - bytes   (wire type 2)  — for string, bytes, embedded messages
 *
 * No support for fixed32/64, groups (deprecated), or packed repeated
 * fields. Add as needed.
 */

export class ProtoWriter {
  private buf: number[] = [];

  /** Write a tag byte: (fieldNumber << 3) | wireType. */
  private tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  /** Encode a JS number/bigint as a base-128 varint. */
  varint(value: number | bigint): this {
    let v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) v = (1n << 64n) + v;
    while (v >= 0x80n) {
      this.buf.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.buf.push(Number(v));
    return this;
  }

  /** Field with varint value (int32, int64, uint32, uint64, bool, enum). */
  fieldVarint(field: number, value: number | bigint): this {
    this.tag(field, 0);
    return this.varint(value);
  }

  /** Field with raw bytes (also used for string + embedded message). */
  fieldBytes(field: number, bytes: Uint8Array): this {
    this.tag(field, 2);
    this.varint(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i++) this.buf.push(bytes[i]!);
    return this;
  }

  /** Field with a fixed64 value (8 bytes, little-endian on wire — proto3 spec). */
  fieldFixed64(field: number, value: bigint): this {
    this.tag(field, 1);
    let v = value < 0n ? (1n << 64n) + value : value;
    for (let i = 0; i < 8; i++) {
      this.buf.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return this;
  }

  /** Field with a string (UTF-8 encoded). */
  fieldString(field: number, str: string): this {
    return this.fieldBytes(field, new TextEncoder().encode(str));
  }

  /** Field with an embedded message — caller builds the inner ProtoWriter. */
  fieldMessage(field: number, build: (inner: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    build(inner);
    return this.fieldBytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

/**
 * Convert a hyphenated UUID string into its 16-byte representation.
 *
 *   uuidToBytes("527be2ff-aaec-4622-9c68-79d200b8bdc1")
 *   → Uint8Array(16) [0x52, 0x7b, 0xe2, ...]
 *
 * Snap uses these for conversationId, userId, and other identity fields
 * embedded in messaging RPCs. Most of Snap's gRPC schemas wrap the bytes
 * in a single-field message (`{ id: bytes }`) — call sites typically need
 * the raw 16 bytes here and let `fieldMessage` add the wrapper.
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
 * Split a UUID into the {highBits, lowBits} fixed64 pair Snap uses in some
 * RPCs (e.g. FriendAction.AddFriends) instead of the bytes16 wrapper.
 *
 * - highBits = big-endian uint64 of UUID bytes 0..7
 * - lowBits  = big-endian uint64 of UUID bytes 8..15
 *
 * Caller passes them through ProtoWriter.fieldFixed64 (LE-encoded on wire,
 * matching what we see in captured traffic).
 */
export function uuidToHighLow(uuid: string): { high: bigint; low: bigint } {
  const bytes = uuidToBytes(uuid);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { high: dv.getBigUint64(0, false), low: dv.getBigUint64(8, false) };
}

/** Inverse: 16-byte buffer → hyphenated UUID string. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) {
    throw new Error(`expected 16 bytes for UUID, got ${bytes.byteLength}`);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Minimal proto3 wire-format reader. Pull-style API: each `next()` returns
 * the next field tag + payload, skipping unknown wire types. Caller
 * dispatches on field number.
 *
 * Only supports the same wire types as ProtoWriter: varint and length-
 * delimited bytes/messages. Repeated fields are surfaced as multiple
 * adjacent reads with the same field number — the consumer collects them
 * into arrays.
 */
export class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  hasMore(): boolean {
    return this.pos < this.buf.byteLength;
  }

  /**
   * Read the next tag. Returns null at end-of-buffer. Otherwise returns
   * `{ field, wireType }`. Caller is responsible for calling the matching
   * `varint()` or `bytes()` after.
   */
  next(): { field: number; wireType: number } | null {
    if (!this.hasMore()) return null;
    const tag = this.varint();
    return { field: Number(tag >> 3n), wireType: Number(tag & 0x7n) };
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      if (this.pos >= this.buf.byteLength) throw new Error("varint truncated");
      b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while ((b & 0x80) !== 0);
    return result;
  }

  /** Length-delimited payload. Caller decides if it's a string, bytes, or sub-message. */
  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.buf.byteLength) throw new Error("bytes field truncated");
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /** Read a sub-message and return a new ProtoReader scoped to its bytes. */
  message(): ProtoReader {
    return new ProtoReader(this.bytes());
  }

  /** Read a UTF-8 string. */
  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  /**
   * Skip a field whose wire type we don't care about. Required for forward
   * compatibility — Snap can add fields without breaking us.
   *
   * Wire types covered: 0 (varint), 1 (fixed64), 2 (length-delimited),
   * 5 (fixed32). The spec also defines 3/4 (start/end-group, deprecated);
   * we don't see them in modern Snap protos and treat them as fatal.
   */
  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.varint(); break;
      case 1: this.pos += 8; break;
      case 2: this.bytes(); break;
      case 5: this.pos += 4; break;
      default: throw new Error(`unsupported wire type for skip: ${wireType}`);
    }
  }
}
