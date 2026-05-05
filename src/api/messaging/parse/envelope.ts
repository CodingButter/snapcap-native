/**
 * Inbound envelope plaintext + UUID extraction helpers.
 *
 * `extractFirstUuidFromResp` recovers the assigned messageId from a
 * `CreateContentMessage` response.
 *
 * `extractPlaintextBody` walks an envelope for any printable UTF-8
 * field — surfaces non-E2E AI-bot replies, MEMORIES bodies, and
 * plaintext metadata (media URLs / IDs) embedded next to the encrypted
 * text body.
 *
 * @internal
 */
import { bytesToUuid } from "../../_helpers.ts";
import { ProtoReader } from "./proto-reader.ts";

/**
 * Walk a CreateContentMessage response looking for a 16-byte UUID — the
 * server stamps the assigned messageId on the response envelope. Returns
 * the first 16-byte field's hyphenated form, or `undefined` if none
 * found.
 *
 * The response shape varies subtly by content kind, but every shape
 * carries the assigned message UUID somewhere as a 16-byte field; a
 * shallow walk through the top-level fields is sufficient.
 *
 * @internal
 */
export function extractFirstUuidFromResp(envelope: Uint8Array): string | undefined {
  if (envelope.byteLength === 0) return undefined;
  let r: ProtoReader;
  try { r = new ProtoReader(envelope); } catch { return undefined; }
  while (r.pos < envelope.byteLength) {
    const n = r.next(); if (!n) break;
    if (n.wireType === 2) {
      let bb: Uint8Array;
      try { bb = r.bytes(); } catch { return undefined; }
      if (bb.byteLength === 16) return bytesToUuid(bb);
      // Recurse one level into nested messages
      let rr: ProtoReader;
      try { rr = new ProtoReader(bb); } catch { continue; }
      while (rr.pos < bb.byteLength) {
        const nn = rr.next(); if (!nn) break;
        if (nn.wireType === 2) {
          let ibb: Uint8Array;
          try { ibb = rr.bytes(); } catch { break; }
          if (ibb.byteLength === 16) return bytesToUuid(ibb);
        } else rr.skip(nn.wireType);
      }
    } else r.skip(n.wireType);
  }
  return undefined;
}

/**
 * Walk a proto buffer for plaintext text bodies. Picks up any UTF-8 string
 * field whose content is mostly ASCII-printable + has at least one letter.
 *
 * Non-E2E messages (AI bot, MEMORIES) carry the message text directly.
 * E2E messages embed plaintext METADATA — media URLs, snap IDs, signed
 * cookies — alongside the encrypted text body, so this returns *what's
 * available* (URL, ID, etc.) when no actual text body is present.
 *
 * Surfaces ALL strings as a `\n`-joined block when there are multiple,
 * so callers see the full plaintext context, not just the longest field.
 *
 * @internal
 */
export function extractPlaintextBody(envelope: Uint8Array): string | undefined {
  const found: string[] = [];
  function walk(b: Uint8Array, depth = 0): void {
    if (depth > 10 || b.byteLength === 0) return;
    let r: ProtoReader;
    try { r = new ProtoReader(b); } catch { return; }
    while (r.pos < b.byteLength) {
      const n = r.next(); if (!n) break;
      if (n.wireType === 2) {
        let bb: Uint8Array;
        try { bb = r.bytes(); } catch { return; }
        if (bb.byteLength >= 1 && bb.byteLength < 4096) {
          const txt = new TextDecoder("utf-8", { fatal: false }).decode(bb);
          let printable = 0; let letters = 0;
          for (let i = 0; i < bb.byteLength; i++) {
            const c = bb[i]!;
            if (c >= 0x20 && c <= 0x7e) printable++;
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
          }
          // Accept strings that are mostly printable AND have at least 2
          // letters (catch URLs, slugs, base64 IDs, message text). Reject
          // pure 16-byte UUIDs (handled separately) and very short noise.
          if (letters >= 2 && printable / bb.byteLength > 0.85 && bb.byteLength >= 4 && bb.byteLength !== 16) {
            found.push(txt);
          } else if (printable / bb.byteLength < 0.5 || bb.byteLength === 16) {
            // Almost certainly binary — try as nested message
            try { walk(bb, depth + 1); } catch { /* not msg */ }
          } else {
            // Mixed — try as message, fall back to text
            try { walk(bb, depth + 1); } catch { /* not msg */ }
          }
        } else {
          try { walk(bb, depth + 1); } catch { /* not msg */ }
        }
      } else r.skip(n.wireType);
    }
  }
  try { walk(envelope, 0); } catch { /* best-effort */ }
  if (found.length === 0) return undefined;
  // Dedupe + concat — caller sees the FULL plaintext context.
  const uniq = Array.from(new Set(found));
  uniq.sort((a, b) => b.length - a.length);
  return uniq.join(" | ");
}
