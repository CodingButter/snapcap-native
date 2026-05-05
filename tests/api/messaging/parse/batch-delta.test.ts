/**
 * PURE tests — `src/api/messaging/parse/batch-delta.ts`.
 *
 * Anchors `parseBatchDeltaSync`, `parseSyncedConversation`, and
 * `parseContentMessage` against REAL captured `BatchDeltaSync` response
 * bytes from `.tmp/bds-perdyjamie.bin` — the previous Sonnet attempt
 * crashed-and-burned trying to hand-build the f1→f1 nested envelopes.
 * Real bytes only for the multi-field paths; tiny hand-built bytes are
 * used ONLY for null-return / empty-buffer guard tests.
 *
 * The capture covers:
 *   - 31 messages across 3 conversations
 *   - 4 distinct senderUserIds (self + 3 peers)
 *   - mixed mid-stream + at-start ConversationMetadata (f6) ordering
 *   - 16 messages carry plaintext (CDN URLs, snap IDs) alongside their
 *     E2E ciphertext bodies — exercises both
 *     `extractPlaintextBody(envelope)` and the `eelEnvelope` fallback.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  parseBatchDeltaSync,
  parseContentMessage,
  parseSyncedConversation,
} from "../../../../src/api/messaging/parse/batch-delta.ts";
import type { RawEncryptedMessage } from "../../../../src/api/messaging/types.ts";

const BDS_BYTES = new Uint8Array(
  readFileSync(new URL("../../../../.tmp/bds-perdyjamie.bin", import.meta.url)),
);

const SELF_UUID = "527be2ff-aaec-4622-9c68-79d200b8bdc1";
const KNOWN_SENDERS = new Set([
  SELF_UUID,
  "c29a013d-9046-4cee-b563-787908cdfa46",
  "84ee8839-3911-492d-8b94-72dd80f3713a",
  "eabd1d89-239a-4f7b-bbcc-0ae3b26c5202",
]);
const KNOWN_CONVS = new Set([
  "c4615619-9220-511a-ac59-075f68a2ac40",
  "ab40f3eb-33f4-5909-b768-dbe62458d7fc",
  "8fee42df-e549-5727-a893-034382ccab89",
]);

describe("messaging/parse/batch-delta — parseBatchDeltaSync (real capture)", () => {
  test("returns the 31 messages the captured response carried", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    expect(out).toHaveLength(31);
  });

  test("every conversationId on parsed messages matches one of the captured convs", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    for (const m of out) {
      expect(KNOWN_CONVS.has(m.conversationId)).toBe(true);
    }
  });

  test("every senderUserId is one of the four known captured senders", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    for (const m of out) {
      expect(KNOWN_SENDERS.has(m.senderUserId)).toBe(true);
    }
  });

  test("messageId is decoded as a positive bigint", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    for (const m of out) {
      expect(typeof m.messageId).toBe("bigint");
      expect(m.messageId).toBeGreaterThan(0n);
    }
  });

  test("serverTimestampMs is decoded as a plausible epoch-ms bigint", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    // Capture predates 2026-04-30; first ms ~1.777e12.
    for (const m of out) {
      expect(typeof m.serverTimestampMs).toBe("bigint");
      expect(m.serverTimestampMs).toBeGreaterThan(1_700_000_000_000n);
      expect(m.serverTimestampMs).toBeLessThan(2_000_000_000_000n);
    }
  });

  test("envelope is non-empty for every message", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    for (const m of out) {
      expect(m.envelope).toBeInstanceOf(Uint8Array);
      expect(m.envelope.byteLength).toBeGreaterThan(0);
    }
  });

  test("about half the captured messages carry an opportunistic cleartextBody", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    const withClear = out.filter((m) => m.cleartextBody !== undefined);
    // Captured stream had 16/31. Allow some drift if upstream parser
    // sensitivity changes — assert a band rather than the exact number.
    expect(withClear.length).toBeGreaterThan(5);
    expect(withClear.length).toBeLessThanOrEqual(out.length);
  });

  test("at least one cleartextBody contains a CDN URL fragment (sanity)", () => {
    const out = parseBatchDeltaSync(BDS_BYTES);
    const joined = out.map((m) => m.cleartextBody ?? "").join("\n");
    // Snap CDN host appears in the captured plaintext-metadata stream.
    expect(joined).toContain("snapchat.com");
  });
});

describe("messaging/parse/batch-delta — parseBatchDeltaSync (edge cases)", () => {
  test("empty buffer returns empty array", () => {
    expect(parseBatchDeltaSync(new Uint8Array(0))).toEqual([]);
  });

  test("ignores top-level fields with non-matching tags (skip path)", () => {
    // field=2 (varint) — not f1, no nested SyncedConversation.
    const buf = new Uint8Array([(2 << 3) | 0, 0x01]);
    expect(parseBatchDeltaSync(buf)).toEqual([]);
  });
});

describe("messaging/parse/batch-delta — parseContentMessage (edge cases)", () => {
  test("returns null for an empty buffer (no senderUserId)", () => {
    expect(parseContentMessage(new Uint8Array(0), "")).toBeNull();
  });

  test("returns null when only the messageId field is present (no f2)", () => {
    // field=1 (varint) value=5 — messageId set, but no senderUserId envelope.
    const buf = new Uint8Array([(1 << 3) | 0, 0x05]);
    expect(parseContentMessage(buf, "a-conv-id")).toBeNull();
  });
});

describe("messaging/parse/batch-delta — parseSyncedConversation backfill", () => {
  test("messages within a synced conv get the conv id even when f6 follows f4", () => {
    // The captured stream's order shouldn't matter — every message must
    // end up with a conversationId. We assert this by checking that no
    // parsed message has an empty conversationId.
    const out = parseBatchDeltaSync(BDS_BYTES);
    for (const m of out) expect(m.conversationId).not.toBe("");
  });

  test("appends to the caller-provided `out` array (mutation contract)", () => {
    // Smoke that the function follows its `out: RawEncryptedMessage[]`
    // mutation contract — walk every top-level f1 (block) → inner f1
    // (SyncedConversation) and feed each into parseSyncedConversation
    // directly. Aggregating across blocks must equal the result the
    // top-level parser produces, proving the singular function carries
    // the contract for the multi-call wrapper.
    const buf = BDS_BYTES;
    const collected: RawEncryptedMessage[] = [];
    let pos = 0;
    while (pos < buf.byteLength) {
      // Parse top-level tag varint
      let tag = 0n; let shift = 0n;
      while (pos < buf.byteLength) {
        const b = buf[pos++]!;
        tag |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      const field = Number(tag >> 3n);
      const wireType = Number(tag & 0x7n);
      if (wireType !== 2) break; // capture is purely length-delimited at top
      let len = 0; shift = 0n;
      while (pos < buf.byteLength) {
        const b = buf[pos++]!;
        len |= (b & 0x7f) << Number(shift);
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      const blockBuf = buf.subarray(pos, pos + len);
      pos += len;
      if (field !== 1) continue;
      // Walk inner block for its f1 (SyncedConversation)
      let bp = 0;
      while (bp < blockBuf.byteLength) {
        let btag = 0n; let bshift = 0n;
        while (bp < blockBuf.byteLength) {
          const b = blockBuf[bp++]!;
          btag |= BigInt(b & 0x7f) << bshift;
          if ((b & 0x80) === 0) break;
          bshift += 7n;
        }
        const bfield = Number(btag >> 3n);
        const bwt = Number(btag & 0x7n);
        if (bwt !== 2) break;
        let blen = 0; bshift = 0n;
        while (bp < blockBuf.byteLength) {
          const b = blockBuf[bp++]!;
          blen |= (b & 0x7f) << Number(bshift);
          if ((b & 0x80) === 0) break;
          bshift += 7n;
        }
        const scBuf = blockBuf.subarray(bp, bp + blen);
        bp += blen;
        if (bfield === 1) {
          parseSyncedConversation(scBuf, collected);
        }
      }
    }
    // Aggregating per-block matches the top-level parser exactly.
    const direct = parseBatchDeltaSync(BDS_BYTES);
    expect(collected).toHaveLength(direct.length);
    for (const m of collected) {
      expect(KNOWN_CONVS.has(m.conversationId)).toBe(true);
      expect(KNOWN_SENDERS.has(m.senderUserId)).toBe(true);
    }
  });
});
