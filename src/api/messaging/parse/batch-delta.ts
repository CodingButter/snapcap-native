/**
 * Parse BatchDeltaSync responses from MessagingCoreService.
 *
 * Walks each conversation block; for each ContentMessage, extracts
 * `(conversationId, senderUserId, messageId, envelope bytes)` plus an
 * opportunistic `cleartextBody` when the envelope embeds plaintext
 * (non-E2E AI bot replies, plaintext metadata next to the encrypted
 * text body).
 *
 * @internal
 */
import { bytesToUuid } from "../../_helpers.ts";
import type { RawEncryptedMessage } from "../types.ts";
import { ProtoReader } from "./proto-reader.ts";
import { extractPlaintextBody } from "./envelope.ts";

/**
 * Parse a BatchDeltaSync response and surface every encrypted message
 * envelope. Walks each conversation block; for each ContentMessage,
 * extracts `(conversationId, senderUserId, messageId, envelope bytes)`.
 *
 * If the message body contains a plaintext content sub-message (e.g. AI
 * bot replies are not E2E), surface that as `cleartextBody`.
 *
 * @internal
 */
export function parseBatchDeltaSync(buf: Uint8Array): RawEncryptedMessage[] {
  const out: RawEncryptedMessage[] = [];
  const r = new ProtoReader(buf);
  // Top-level: repeated f1 (one per conversation block).
  // Each block wraps another f1 = SyncedConversation, which has:
  //   f1: type
  //   f2: timestamp
  //   f6: ConversationMetadata (subobjects)
  //   f3: ConversationLayout (subobjects)
  //   f4: ContentMessage (repeated)  ← the messages we want
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) {
      const block = r.bytes();
      // Block has one f1 wrapper containing the SyncedConversation
      const blockR = new ProtoReader(block);
      for (let b = blockR.next(); b; b = blockR.next()) {
        if (b.field === 1 && b.wireType === 2) {
          const sc = blockR.bytes();
          parseSyncedConversation(sc, out);
        } else blockR.skip(b.wireType);
      }
    } else r.skip(n.wireType);
  }
  return out;
}

/**
 * Parse a single SyncedConversation block (`f1` inside a top-level
 * `f1`) into zero-or-more {@link RawEncryptedMessage}s appended to
 * `out`. Backfills the conversationId on collected messages when `f6`
 * (metadata) appeared after the `f4` (ContentMessage) entries.
 *
 * @internal
 */
export function parseSyncedConversation(buf: Uint8Array, out: RawEncryptedMessage[]): void {
  const r = new ProtoReader(buf);
  let convId = "";
  const collected: RawEncryptedMessage[] = [];
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 6 && n.wireType === 2) {
      // ConversationMetadata — extract conversationId from f1.f1.f1
      const meta = r.bytes();
      const mr = new ProtoReader(meta);
      for (let m = mr.next(); m; m = mr.next()) {
        if (m.field === 1 && m.wireType === 2) {
          const sub = mr.bytes();
          const sr = new ProtoReader(sub);
          for (let s = sr.next(); s; s = sr.next()) {
            if (s.field === 1 && s.wireType === 2) {
              const inner = sr.bytes();
              const ir = new ProtoReader(inner);
              for (let i = ir.next(); i; i = ir.next()) {
                if (i.field === 1 && i.wireType === 2) {
                  const u = ir.bytes();
                  if (u.byteLength === 16) convId = bytesToUuid(u);
                } else ir.skip(i.wireType);
              }
            } else sr.skip(s.wireType);
          }
        } else mr.skip(m.wireType);
      }
    } else if (n.field === 4 && n.wireType === 2) {
      // ContentMessage
      const cm = r.bytes();
      const msg = parseContentMessage(cm, convId);
      if (msg) collected.push(msg);
    } else r.skip(n.wireType);
  }
  // Backfill convId on collected messages (in case f6 came after f4)
  for (const m of collected) {
    if (!m.conversationId) m.conversationId = convId;
    out.push(m);
  }
}

/**
 * Parse one `ContentMessage` (`f4` on a SyncedConversation) into a
 * {@link RawEncryptedMessage}. Returns `null` when the envelope has no
 * recoverable senderUserId.
 *
 * Surfaces both the ContentEnvelope (`f3`) and the EelEncryption
 * envelope (`f4`); when present the EelEncryption envelope wins as the
 * `envelope` field because it carries the AES-GCM ciphertext + plaintext
 * metadata. `cleartextBody` is opportunistically extracted from
 * whichever side has printable content.
 *
 * @internal
 */
export function parseContentMessage(buf: Uint8Array, conversationId: string): RawEncryptedMessage | null {
  const r = new ProtoReader(buf);
  let messageId = 0n;
  let senderUserId = "";
  let envelope = new Uint8Array(0);
  let eelEnvelope = new Uint8Array(0);
  let serverTimestampMs = 0n;
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 0) {
      messageId = r.varint();
    } else if (n.field === 2 && n.wireType === 2) {
      // {1: bytes16 senderUserId}
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 2) {
          const u = sr.bytes();
          if (u.byteLength === 16) senderUserId = bytesToUuid(u);
        } else sr.skip(s.wireType);
      }
    } else if (n.field === 3 && n.wireType === 2) {
      // ContentEnvelope
      envelope = new Uint8Array(r.bytes());
    } else if (n.field === 4 && n.wireType === 2) {
      // EelEncryption envelope — carries the AES-GCM ciphertext + metadata.
      // Snap *sometimes* embeds plaintext metadata (media URLs, timestamps,
      // snap IDs) here even when the message body itself is E2E-wrapped —
      // attachment bodies live on the CDN behind the URLs and the ciphertext
      // is just the message TEXT.
      eelEnvelope = new Uint8Array(r.bytes());
    } else if (n.field === 6 && n.wireType === 2) {
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 0) serverTimestampMs = sr.varint();
        else sr.skip(s.wireType);
      }
    } else r.skip(n.wireType);
  }
  if (!senderUserId) return null;
  // Surface plaintext from EITHER the ContentEnvelope OR the EelEncryption
  // envelope — Snap stores media URLs / snap IDs in plaintext alongside the
  // E2E-wrapped body.
  const cleartextBody = extractPlaintextBody(envelope) ?? extractPlaintextBody(eelEnvelope);
  return {
    conversationId,
    senderUserId,
    messageId,
    serverTimestampMs,
    envelope: eelEnvelope.byteLength > 0 ? eelEnvelope : envelope,
    cleartextBody,
  };
}
