/**
 * Parse SyncConversations responses from MessagingCoreService.
 *
 * Each top-level `f1` is one conversation envelope; we extract
 * `{conversationId, type, participants}`.
 *
 * @internal
 */
import { bytesToUuid } from "../../_helpers.ts";
import type { ConversationSummary } from "../types.ts";
import { ProtoReader } from "./proto-reader.ts";

/**
 * Parse a SyncConversations response. Each top-level `f1` is one
 * conversation envelope; we extract `{conversationId, type, participants}`.
 *
 * @internal
 */
export function parseSyncConversations(buf: Uint8Array): ConversationSummary[] {
  const out: ConversationSummary[] = [];
  const r = new ProtoReader(buf);
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) {
      const conv = r.bytes();
      const summary = parseOneSyncedConversation(conv);
      if (summary) out.push(summary);
    } else r.skip(n.wireType);
  }
  return out;
}

/**
 * Parse a single conversation envelope (f1) into a {@link ConversationSummary}.
 *
 * Returns `null` when the envelope has no recoverable conversationId.
 *
 * @internal
 */
export function parseOneSyncedConversation(buf: Uint8Array): ConversationSummary | null {
  const r = new ProtoReader(buf);
  let convId = "";
  let type = 0;
  const participants: string[] = [];
  for (let n = r.next(); n; n = r.next()) {
    if (n.field === 1 && n.wireType === 2) {
      const sub = r.bytes();
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
        } else if (s.field === 2 && s.wireType === 0) {
          type = Number(sr.varint());
        } else sr.skip(s.wireType);
      }
    } else if (n.field === 7 && n.wireType === 2) {
      const sub = r.bytes();
      const sr = new ProtoReader(sub);
      for (let s = sr.next(); s; s = sr.next()) {
        if (s.field === 1 && s.wireType === 2) {
          const u = sr.bytes();
          if (u.byteLength === 16) participants.push(bytesToUuid(u));
        } else sr.skip(s.wireType);
      }
    } else r.skip(n.wireType);
  }
  return convId ? { conversationId: convId, type, participants } : null;
}
