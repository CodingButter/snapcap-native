/**
 * PURE unit tests — `src/api/messaging/parse/proto-reader.ts`.
 *
 * `ProtoReader` is the inline protobuf wire-format walker used by every
 * `parse/*` sibling. The tests below exercise the four primitive
 * operations:
 *
 *   - `varint()` — base-128 decode (single byte through multi-byte)
 *   - `next()` — tag decode (returns `{field, wireType}` or `null` at EOF)
 *   - `bytes()` — length-delimited subarray (wireType=2 payload)
 *   - `skip(wireType)` — wire-format-aware skip past unknown fields
 *
 * Hand-built byte fixtures are intentional here — the wire format is
 * trivial enough at this primitive layer that constructing them inline
 * is more legible than loading captured bytes. (For higher-level parsers
 * that walk multi-field nested structures, captured fixtures from
 * `.tmp/` are mandatory; see `sync-conversations.test.ts`.)
 */
import { describe, expect, test } from "bun:test";
import { ProtoReader } from "../../../../src/api/messaging/parse/proto-reader.ts";

describe("messaging/parse/proto-reader — varint", () => {
  test("decodes a single-byte varint (value < 128)", () => {
    const r = new ProtoReader(new Uint8Array([0x07]));
    expect(r.varint()).toBe(7n);
    expect(r.pos).toBe(1);
  });

  test("decodes a single-byte varint with high-bit-clear stop", () => {
    const r = new ProtoReader(new Uint8Array([0x7f]));
    expect(r.varint()).toBe(127n);
    expect(r.pos).toBe(1);
  });

  test("decodes a multi-byte varint (continuation bit handling)", () => {
    // 300 = 0xAC 0x02 (binary: 10101100 00000010 → 0000010 0101100 = 300)
    const r = new ProtoReader(new Uint8Array([0xac, 0x02]));
    expect(r.varint()).toBe(300n);
    expect(r.pos).toBe(2);
  });

  test("decodes a large multi-byte varint", () => {
    // 1_777_525_016_961 ≈ 41-bit value; encodes as 6 bytes
    const big = 1_777_525_016_961n;
    const bytes: number[] = [];
    let v = big;
    while (v > 0x7fn) { bytes.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
    bytes.push(Number(v));
    const r = new ProtoReader(new Uint8Array(bytes));
    expect(r.varint()).toBe(big);
  });

  test("returns 0n for empty buffer (defensive)", () => {
    const r = new ProtoReader(new Uint8Array(0));
    expect(r.varint()).toBe(0n);
  });
});

describe("messaging/parse/proto-reader — next", () => {
  test("returns null at end of buffer", () => {
    const r = new ProtoReader(new Uint8Array(0));
    expect(r.next()).toBeNull();
  });

  test("decodes field=1, wireType=2 (length-delimited)", () => {
    // Tag = (field << 3) | wireType  →  (1 << 3) | 2 = 0x0a
    const r = new ProtoReader(new Uint8Array([0x0a]));
    expect(r.next()).toEqual({ field: 1, wireType: 2 });
  });

  test("decodes field=4, wireType=0 (varint)", () => {
    // Tag = (4 << 3) | 0 = 0x20
    const r = new ProtoReader(new Uint8Array([0x20]));
    expect(r.next()).toEqual({ field: 4, wireType: 0 });
  });

  test("decodes a high-numbered field (multi-byte tag varint)", () => {
    // field=16, wireType=2  →  tag=(16<<3)|2 = 0x82, encoded as varint:
    // 0x82 = 130 → multi-byte: 0x82 0x01 (130 = 0b00000001 0000010)
    const r = new ProtoReader(new Uint8Array([0x82, 0x01]));
    expect(r.next()).toEqual({ field: 16, wireType: 2 });
  });
});

describe("messaging/parse/proto-reader — bytes", () => {
  test("returns a length-prefixed subarray", () => {
    // length = 4, payload = 0x01 0x02 0x03 0x04
    const r = new ProtoReader(new Uint8Array([0x04, 0x01, 0x02, 0x03, 0x04]));
    const out = r.bytes();
    expect(out).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    expect(r.pos).toBe(5);
  });

  test("returns an empty subarray for length=0", () => {
    const r = new ProtoReader(new Uint8Array([0x00]));
    expect(r.bytes()).toEqual(new Uint8Array(0));
    expect(r.pos).toBe(1);
  });

  test("subarray is a view into the source buffer", () => {
    const src = new Uint8Array([0x02, 0xAA, 0xBB]);
    const r = new ProtoReader(src);
    const out = r.bytes();
    expect(out.byteLength).toBe(2);
    expect(out.byteOffset).toBe(1);
    expect(out.buffer).toBe(src.buffer);
  });
});

describe("messaging/parse/proto-reader — skip", () => {
  test("skips a varint (wireType 0)", () => {
    // value = 300 = [0xac, 0x02]
    const r = new ProtoReader(new Uint8Array([0xac, 0x02, 0xff]));
    r.skip(0);
    expect(r.pos).toBe(2);
  });

  test("skips a length-delimited (wireType 2) field", () => {
    const r = new ProtoReader(new Uint8Array([0x03, 0x01, 0x02, 0x03, 0xff]));
    r.skip(2);
    expect(r.pos).toBe(4);
  });

  test("skips an 8-byte fixed64 (wireType 1)", () => {
    const r = new ProtoReader(new Uint8Array(10));
    r.skip(1);
    expect(r.pos).toBe(8);
  });

  test("skips a 4-byte fixed32 (wireType 5)", () => {
    const r = new ProtoReader(new Uint8Array(10));
    r.skip(5);
    expect(r.pos).toBe(4);
  });

  test("is a no-op for unknown wire types (graceful)", () => {
    const r = new ProtoReader(new Uint8Array([0x01, 0x02]));
    r.skip(7); // unknown wire type
    expect(r.pos).toBe(0);
  });
});

describe("messaging/parse/proto-reader — composite walks", () => {
  test("walks a tag → bytes → tag → varint → null sequence", () => {
    // field=1 wt=2 len=3 [aa bb cc]; field=2 wt=0 value=42
    const buf = new Uint8Array([0x0a, 0x03, 0xaa, 0xbb, 0xcc, 0x10, 0x2a]);
    const r = new ProtoReader(buf);
    const t1 = r.next();
    expect(t1).toEqual({ field: 1, wireType: 2 });
    expect(r.bytes()).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    const t2 = r.next();
    expect(t2).toEqual({ field: 2, wireType: 0 });
    expect(r.varint()).toBe(42n);
    expect(r.next()).toBeNull();
  });

  test("custom `pos` lets caller resume mid-buffer", () => {
    const buf = new Uint8Array([0xff, 0x0a, 0x01, 0xaa]);
    const r = new ProtoReader(buf, 1);
    expect(r.next()).toEqual({ field: 1, wireType: 2 });
    expect(r.bytes()).toEqual(new Uint8Array([0xaa]));
  });
});
