/**
 * PURE tests — `src/api/messaging/parse/sync-conversations.ts`.
 *
 * Walks `parseSyncConversations` and `parseOneSyncedConversation` over
 * REAL captured proto bytes (`.tmp/sync-conv-perdyjamie.bin`) — the
 * captured response from a live `MessagingCoreService.SyncConversations`
 * RPC. Hand-built fixtures are NOT used here: the wire format is too
 * easy to encode subtly wrong, and the previous Sonnet attempt at this
 * file got stuck in exactly that trap. Real bytes only.
 *
 * The captured fixture covers:
 *   - 8 conversations spanning multiple `type` codes (3, 5, 13, 25, 38, 420)
 *   - participants in both `[self, other]` and `[other, self]` orders
 *   - real 16-byte UUID payloads under the f1.f1.f1.f1 envelope nesting
 *
 * Assertions are anchored to the values we observed when running the
 * parser on this fixture; the parser's contract is preserved as a
 * regression gate. Any change in shape (e.g. an extra field added) will
 * surface here without a guesswork rebuild.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  parseOneSyncedConversation,
  parseSyncConversations,
} from "../../../../src/api/messaging/parse/sync-conversations.ts";

/** Captured `SyncConversations` response bytes from perdyjamie's account. */
const SYNC_CONV_BYTES = new Uint8Array(
  readFileSync(new URL("../../../../.tmp/sync-conv-perdyjamie.bin", import.meta.url)),
);

/** The signed-in user that captured the fixture. Appears as a participant
 * in every conv. */
const SELF_UUID = "527be2ff-aaec-4622-9c68-79d200b8bdc1";

describe("messaging/parse/sync-conversations — parseSyncConversations (real capture)", () => {
  test("returns the 8 conversations the captured response carried", () => {
    const out = parseSyncConversations(SYNC_CONV_BYTES);
    expect(out).toHaveLength(8);
  });

  test("every conversationId is a hyphenated 36-char UUID", () => {
    const out = parseSyncConversations(SYNC_CONV_BYTES);
    for (const c of out) {
      expect(c.conversationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  test("each conv carries exactly 2 participants in this DM-heavy capture", () => {
    const out = parseSyncConversations(SYNC_CONV_BYTES);
    for (const c of out) expect(c.participants).toHaveLength(2);
  });

  test("self UUID appears in every conversation's participants", () => {
    const out = parseSyncConversations(SYNC_CONV_BYTES);
    for (const c of out) expect(c.participants).toContain(SELF_UUID);
  });

  test("preserves the captured `type` codes (DM=5, group=13, special-kind=420)", () => {
    const out = parseSyncConversations(SYNC_CONV_BYTES);
    const types = out.map((c) => c.type);
    // The capture contains: [420, 3, 3, 38, 25, 13, 5, 5]
    expect(types).toContain(420);
    expect(types).toContain(13);
    expect(types).toContain(5);
    expect(types).toContain(3);
    // Every type is a non-negative integer.
    for (const t of types) {
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
    }
  });

  test("first conv pinpoints the exact captured shape (regression)", () => {
    const out = parseSyncConversations(SYNC_CONV_BYTES);
    expect(out[0]).toEqual({
      conversationId: "8fee42df-e549-5727-a893-034382ccab89",
      type: 420,
      participants: [
        SELF_UUID,
        "eabd1d89-239a-4f7b-bbcc-0ae3b26c5202",
      ],
    });
  });
});

describe("messaging/parse/sync-conversations — parseSyncConversations (edge cases)", () => {
  test("empty buffer returns empty array", () => {
    expect(parseSyncConversations(new Uint8Array(0))).toEqual([]);
  });

  test("ignores top-level fields with non-matching tags (skip path)", () => {
    // Wrap a single varint-typed field=2 we expect to be skipped, then EOF.
    // Tag = (2 << 3) | 0 = 0x10, value=42
    const buf = new Uint8Array([0x10, 0x2a]);
    expect(parseSyncConversations(buf)).toEqual([]);
  });
});

describe("messaging/parse/sync-conversations — parseOneSyncedConversation", () => {
  test("returns null when the envelope has no recoverable conversationId", () => {
    // Empty conv envelope = zero fields read = empty convId → null.
    expect(parseOneSyncedConversation(new Uint8Array(0))).toBeNull();
  });

  test("returns null on a non-matching tag-only buffer", () => {
    // field=99 wt=0 value=1 — neither f1 nor f7; convId stays empty.
    const buf = new Uint8Array([(99 << 3) | 0, 0x01]);
    expect(parseOneSyncedConversation(buf)).toBeNull();
  });

  test("each captured conversation envelope round-trips through the singular parser", () => {
    // Read all top-level f1 envelopes from the sync-conv capture and
    // verify each parses identically through `parseOneSyncedConversation`.
    // Re-uses the proto-reader to re-extract the f1 sub-envelopes the
    // top-level parser walks. Confirms the top-level parser delegates
    // verbatim — no extra wrapping or trimming.
    const expected = parseSyncConversations(SYNC_CONV_BYTES);
    // Reach into the first 1.7 KB capture to extract f1 envelopes.
    let pos = 0;
    const buf = SYNC_CONV_BYTES;
    let i = 0;
    while (pos < buf.byteLength && i < expected.length) {
      // Read tag varint
      let tag = 0n;
      let shift = 0n;
      while (pos < buf.byteLength) {
        const b = buf[pos++]!;
        tag |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      const field = Number(tag >> 3n);
      const wireType = Number(tag & 0x7n);
      // length-delimited only
      if (wireType !== 2) continue;
      let len = 0n; shift = 0n;
      while (pos < buf.byteLength) {
        const b = buf[pos++]!;
        len |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      const sub = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
      if (field === 1) {
        const one = parseOneSyncedConversation(sub);
        expect(one).toEqual(expected[i]!);
        i++;
      }
    }
    expect(i).toBe(expected.length);
  });
});
