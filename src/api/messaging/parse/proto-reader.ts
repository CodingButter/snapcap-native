/**
 * Inline protobuf wire-format reader used by the messaging
 * inbound-parse helpers in this folder.
 *
 * Lives here (not in `transport/`) because the only consumers are the
 * sibling `parse/*` files for `MessagingCoreService` responses
 * (SyncConversations / BatchDeltaSync). If a second area needs proto
 * reading later, lift it to `transport/proto-decode.ts`.
 *
 * @internal
 */
export class ProtoReader {
  constructor(private buf: Uint8Array, public pos = 0) {}
  next(): { field: number; wireType: number } | null {
    if (this.pos >= this.buf.byteLength) return null;
    const tag = this.varint();
    return { field: Number(tag >> 3n), wireType: Number(tag & 0x7n) };
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.byteLength) {
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    return result;
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.bytes();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 5) this.pos += 4;
  }
}
