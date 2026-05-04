/**
 * Minimal proto3 wire-format encoder.
 *
 * Snap's bundle ships full protobufjs encoders for every message it knows
 * about, but a few we want (Fidelius InitializeWebKey, future typing /
 * conversation-update / content-message-update etc.) live in lazy-loaded
 * chunks we don't pre-fetch — or have a hand-built wire shape that
 * doesn't match what the WASM's request emitter produces. Hand-encode
 * with this writer instead.
 *
 * Wire format reference: https://protobuf.dev/programming-guides/encoding/
 *
 * Supports just enough of the spec to serialize the messaging requests:
 *   - varint  (wire type 0)  — for int32, int64, enums, length prefixes
 *   - bytes   (wire type 2)  — for string, bytes, embedded messages
 *   - fixed32 (wire type 5)  — little-endian 4 bytes
 *   - fixed64 (wire type 1)  — little-endian 8 bytes
 *
 * No support for groups (deprecated) or packed repeated fields. Add as
 * needed.
 *
 * @internal
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

  /** Field with a fixed32 value (4 bytes, little-endian on wire). */
  fieldFixed32(field: number, value: number): this {
    this.tag(field, 5);
    let v = value < 0 ? (0x1_0000_0000 + value) >>> 0 : value >>> 0;
    for (let i = 0; i < 4; i++) {
      this.buf.push(v & 0xff);
      v = (v >>> 8) >>> 0;
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
