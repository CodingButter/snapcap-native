/**
 * PURE tests — `src/api/messaging/parse/envelope.ts`.
 *
 * Two helpers:
 *
 *   - `extractFirstUuidFromResp` — recovers the assigned messageId from
 *     a `CreateContentMessage` response by walking until it finds the
 *     first 16-byte field, including one level of nesting.
 *   - `extractPlaintextBody` — best-effort plaintext walk over an
 *     encrypted-message envelope; returns concatenated unique strings or
 *     `undefined` if nothing printable is found.
 *
 * UUID extraction is exercised against simple hand-built bytes (the
 * shape is small enough to encode legibly inline). Plaintext extraction
 * uses captured `ccm_*.bin` envelopes from `.tmp/recon/` for the
 * production-sized cases — the printability heuristic in
 * `extractPlaintextBody` has enough nuance that hand-built fixtures
 * could miss real-world wrinkles.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  extractFirstUuidFromResp,
  extractPlaintextBody,
} from "../../../../src/api/messaging/parse/envelope.ts";

const CCM_0 = new Uint8Array(
  readFileSync(new URL("../../../../.tmp/recon/ccm_0.bin", import.meta.url)),
);
const CCM_1 = new Uint8Array(
  readFileSync(new URL("../../../../.tmp/recon/ccm_1.bin", import.meta.url)),
);

describe("messaging/parse/envelope — extractFirstUuidFromResp", () => {
  test("returns undefined for an empty buffer", () => {
    expect(extractFirstUuidFromResp(new Uint8Array(0))).toBeUndefined();
  });

  test("returns undefined when no 16-byte field is present", () => {
    // field=1 wt=2 len=4, payload=4 bytes (too short for a UUID)
    const buf = new Uint8Array([0x0a, 0x04, 0x01, 0x02, 0x03, 0x04]);
    expect(extractFirstUuidFromResp(buf)).toBeUndefined();
  });

  test("returns the UUID when it appears as a top-level 16-byte field", () => {
    // field=1 wt=2 len=16, payload = sequential bytes
    const uuidBytes = Uint8Array.from(
      [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
       0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00],
    );
    const buf = new Uint8Array(2 + 16);
    buf[0] = 0x0a; // tag: field=1 wt=2
    buf[1] = 0x10; // len=16
    buf.set(uuidBytes, 2);
    expect(extractFirstUuidFromResp(buf)).toBe(
      "11223344-5566-7788-99aa-bbccddeeff00",
    );
  });

  test("recurses one level into a nested message to find the UUID", () => {
    // outer: field=1 wt=2 len=18 → inner: field=1 wt=2 len=16 + UUID
    const uuidBytes = Uint8Array.from(
      [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
       0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00],
    );
    const inner = new Uint8Array(2 + 16);
    inner[0] = 0x0a; inner[1] = 0x10;
    inner.set(uuidBytes, 2);
    const outer = new Uint8Array(2 + inner.byteLength);
    outer[0] = 0x0a;
    outer[1] = inner.byteLength;
    outer.set(inner, 2);
    expect(extractFirstUuidFromResp(outer)).toBe(
      "aabbccdd-eeff-1122-3344-556677889900",
    );
  });

  test("skips non-length-delimited fields and finds UUID later in stream", () => {
    // field=2 wt=0 value=42, then field=3 wt=2 len=16 + UUID
    const uuidBytes = Uint8Array.from(
      [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
       0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10],
    );
    const buf = new Uint8Array(2 + 2 + 16);
    buf[0] = 0x10; buf[1] = 0x2a; // varint field=2 = 42
    buf[2] = 0x1a; // tag field=3 wt=2
    buf[3] = 0x10; // len=16
    buf.set(uuidBytes, 4);
    expect(extractFirstUuidFromResp(buf)).toBe(
      "01020304-0506-0708-090a-0b0c0d0e0f10",
    );
  });

  test("returns a hyphenated UUID from a captured CreateContentMessage response", () => {
    // ccm_0.bin is a real captured `CreateContentMessage` request body —
    // it carries a 16-byte attemptId UUID near the front of the encoded
    // request. The function's contract treats every 16-byte field as a
    // candidate, so it surfaces the first one regardless of which slot
    // it occupies.
    const out = extractFirstUuidFromResp(CCM_0);
    expect(out).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("messaging/parse/envelope — extractPlaintextBody", () => {
  test("returns undefined for an empty buffer", () => {
    expect(extractPlaintextBody(new Uint8Array(0))).toBeUndefined();
  });

  test("returns undefined when no printable strings are found", () => {
    // Single field with a 16-byte UUID payload (rejected per heuristic
    // — pure-UUID is binary noise to the plaintext scanner).
    const buf = new Uint8Array(18);
    buf[0] = 0x0a; buf[1] = 0x10;
    for (let i = 2; i < 18; i++) buf[i] = i; // non-printable bytes
    expect(extractPlaintextBody(buf)).toBeUndefined();
  });

  test("surfaces a printable ASCII text body field", () => {
    const text = "hello world from snap";
    const enc = new TextEncoder().encode(text);
    const buf = new Uint8Array(2 + enc.byteLength);
    buf[0] = 0x0a; buf[1] = enc.byteLength;
    buf.set(enc, 2);
    expect(extractPlaintextBody(buf)).toContain(text);
  });

  test("dedupes + sorts identical strings (single occurrence kept)", () => {
    // Two fields with the same printable string; output is one copy.
    // String length deliberately != 16 (the function rejects 16-byte
    // payloads as candidate UUIDs and recurses instead of surfacing).
    const text = "alphabetagamma";
    const enc = new TextEncoder().encode(text);
    expect(enc.byteLength).not.toBe(16);
    const buf = new Uint8Array(4 + enc.byteLength * 2);
    buf[0] = 0x0a; buf[1] = enc.byteLength;
    buf.set(enc, 2);
    buf[2 + enc.byteLength] = 0x12; buf[3 + enc.byteLength] = enc.byteLength;
    buf.set(enc, 4 + enc.byteLength);
    expect(extractPlaintextBody(buf)).toBe(text);
  });

  test("joins multiple distinct printable strings with ` | ` separator", () => {
    // 9-byte and 18-byte payloads — both bypass the 16-byte rejection.
    const t1 = "firstline";
    const t2 = "second-different-1";
    const e1 = new TextEncoder().encode(t1);
    const e2 = new TextEncoder().encode(t2);
    expect(e1.byteLength).not.toBe(16);
    expect(e2.byteLength).not.toBe(16);
    const buf = new Uint8Array(4 + e1.byteLength + e2.byteLength);
    buf[0] = 0x0a; buf[1] = e1.byteLength;
    buf.set(e1, 2);
    buf[2 + e1.byteLength] = 0x12; buf[3 + e1.byteLength] = e2.byteLength;
    buf.set(e2, 4 + e1.byteLength);
    const out = extractPlaintextBody(buf);
    // Sorted by descending length — both strings appear, joined by " | ".
    expect(out).toContain(t1);
    expect(out).toContain(t2);
    expect(out).toContain(" | ");
  });

  test("rejects strings that are too short (< 4 bytes)", () => {
    // Length 3 — under the min-length threshold (`>= 4`).
    const enc = new TextEncoder().encode("abc");
    const buf = new Uint8Array(2 + enc.byteLength);
    buf[0] = 0x0a; buf[1] = enc.byteLength;
    buf.set(enc, 2);
    expect(extractPlaintextBody(buf)).toBeUndefined();
  });

  test("rejects strings without at least 2 letters", () => {
    // 8-printable-digit string — printable but no letters → rejected.
    const enc = new TextEncoder().encode("12345678");
    const buf = new Uint8Array(2 + enc.byteLength);
    buf[0] = 0x0a; buf[1] = enc.byteLength;
    buf.set(enc, 2);
    expect(extractPlaintextBody(buf)).toBeUndefined();
  });

  test("returns plaintext metadata from a real captured CreateContentMessage envelope", () => {
    // ccm_0.bin embeds plaintext metadata (signed CDN URL slug, snap id)
    // alongside its E2E ciphertext. The capture's plaintext stream
    // carries multiple printable fragments — the function returns them
    // joined with ` | ` separators after dedupe + length-sort.
    const out = extractPlaintextBody(CCM_0);
    expect(typeof out).toBe("string");
    expect(out!.length).toBeGreaterThan(10);
  });

  test("returns undefined for a captured envelope with no printable plaintext", () => {
    // ccm_1.bin is an all-binary envelope from the same recon set — the
    // function's heuristic rejects it. Pinning this so a future
    // sensitivity tweak can't silently flip the contract.
    expect(extractPlaintextBody(CCM_1)).toBeUndefined();
  });
});
