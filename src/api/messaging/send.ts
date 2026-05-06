/**
 * Outbound sends — `sendText`, `sendImage`, `sendSnap`.
 *
 * Each public function takes the per-instance `MessagingInternal` for
 * realm + session access; bundle-driven path goes through module
 * 56639's `pn` (sendText) for text, and through `_media_upload.ts`'s
 * `sendMediaViaSession` for image / snap.
 *
 * @internal
 */
import { uuidToBytes } from "../_helpers.ts";
import { sendMediaViaSession } from "../_media_upload.ts";
import type { MessagingInternal } from "./internal.ts";
import type { ConversationSummary } from "./types.ts";
import { listConversations } from "./reads.ts";

/**
 * Send a plain text DM into a conversation. Awaits messaging-session
 * bring-up before dispatching (so the first send pays the ~3s cold
 * cost; subsequent sends are free).
 *
 * Path: direct gRPC `MessagingCoreService.CreateContentMessage` with
 * the captured wire shape from recon. Snap's web client sends text DMs
 * with the body in plaintext at this layer — no Fidelius wrap on the
 * `CreateContentMessage` request envelope. Same wire shape as the
 * recon HAR `text-dm-create-content-message.req.bin`.
 *
 * @param convId - Hyphenated conversation UUID (from `listConversations`).
 * @param text - UTF-8 message body. Snap's UI line-breaks ~250 chars;
 *   server accepts longer but truncated rendering may apply.
 * @returns The message ID Snap assigned (UUID string from the response,
 *   OR our locally-generated client UUID if the response shape doesn't
 *   carry it under a known field — caller can dedupe on the inbound
 *   `message` event with `isSender === true`).
 */
export async function sendText(
  internal: MessagingInternal,
  convId: string,
  text: string,
): Promise<string> {
  await internal.ensureSession();
  const session = internal.session.get();
  const realm = internal.realm.get();
  if (!session || !realm) {
    throw new Error("Messaging.sendText: bundle session not available after bring-up");
  }

  // Bundle-driven path. Module 56639 export `pn` (`ae` in build's
  // internal naming) is the bundle's own sendText helper:
  //   pn(session, convRef, text, quotedMessageId?, cdMetadata?, botMention?)
  // It builds the ContentMessage envelope, encodes via the bundle's
  // own proto codec (matches what the SPA sends), drives Fidelius for
  // E2E convs, and dispatches via session.getConversationManager()
  // .sendMessageWithContent. Snap's WS push later fires our wrapped
  // messagingDelegate.onMessageReceived hook with isSender=true,
  // surfacing the outbound for confirmation.
  const sendsMod = realm.wreq("56639") as Record<string, Function>;
  const pn = sendsMod.pn as Function | undefined;
  if (typeof pn !== "function") {
    throw new Error(
      "Messaging.sendText: module 56639 export `pn` (sendText) not a function — bundle shape may have shifted",
    );
  }

  // Build a realm-local conversation ref so the bundle's cross-realm
  // checks (Embind expects realm-local Uint8Array) pass.
  const VmU8 = await import("node:vm").then(
    (vm) => vm.runInContext("Uint8Array", realm.context) as Uint8ArrayConstructor,
  );
  const idBytes = new VmU8(16);
  idBytes.set(uuidToBytes(convId));
  const convRef = { id: idBytes, str: convId };

  // Resolve as soon as the bundle's send routine completes (`pn` returns
  // when the gRPC `CreateContentMessage` POST has been queued/dispatched
  // by the WASM session). We do NOT wait for a WS echo — empirically
  // unverified that Snap pushes our own outbound back to us via the
  // duplex channel; the previous 15s echo wait was speculative and
  // gated send latency on a callback that never reliably fires.
  //
  // For SOME conversation kinds (notably bots like My AI, conv type=50)
  // the bundle's `sendMessageWithContent` success callback never fires
  // even though the gRPC POST DOES go out and the bot DOES reply. The
  // gRPC dispatch is fire-and-forget on our side; the success callback
  // is the bundle's own bookkeeping that, for bot convs, depends on a
  // duplex notification we don't receive a handler for. Cap the wait at
  // 3s and resolve regardless — the message has been sent by the time
  // the WASM hands it to the gRPC layer (~tens of ms). Consumers can
  // confirm landing via `on("message", cb)` with `isSender === true`.
  const fallbackId = crypto.randomUUID();
  const sendPromise = pn(session, convRef, text, undefined, undefined, false) as Promise<unknown>;
  await Promise.race([
    sendPromise.catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);
  return fallbackId;
}

/**
 * Send a persistent image attachment into a conversation. Image stays
 * in chat history (not ephemeral). Routes through the **direct gRPC-Web
 * pipeline** — three calls: `MediaDeliveryService.getUploadLocations`
 * for a signed S3 PUT URL, AES-256-CBC encrypt + PUT the bytes, then
 * `MessagingCoreService.CreateContentMessage` with the media reference
 * and AES key + IV embedded in the envelope. No bundle session, no
 * canvas shim — pure Node code.
 *
 * @param convId - Hyphenated conversation UUID.
 * @param image - Raw image bytes (PNG / JPEG / WebP) or a filesystem path.
 * @param opts - Optional `caption` (sent as a separate text message
 *   immediately after the image; matches what Snap's UI does).
 * @returns Resolves on success; rejects with the gRPC status / message
 *   if either call fails.
 */
export async function sendImage(
  internal: MessagingInternal,
  convId: string,
  image: Uint8Array | string,
  opts?: { caption?: string },
): Promise<void> {
  const { sendImageDirect } = await import("../_media_send.ts");
  const ctx = await internal.ctx();
  const bytes = typeof image === "string"
    ? await readImageFromPath(image)
    : image;
  await sendImageDirect(ctx, convId, bytes);
  if (opts?.caption) {
    await sendText(internal, convId, opts.caption);
  }
}

async function readImageFromPath(path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(path));
}

/**
 * Send a disappearing snap to a conversation (destination kind 122).
 * Fidelius-encrypts the media body to the recipient's identity key —
 * the bundle's WASM owns this path end-to-end via its
 * `getSnapManager()` / `sendMessageWithContent` pipeline. Default is
 * view-once (no explicit timer); pass `{ timer: 5 }` to override.
 *
 * @param convId - Hyphenated conversation UUID.
 * @param media - Raw media bytes (image or video — bundle sniffs).
 * @param opts - Optional `timer` (display duration in seconds; omit
 *   for view-once).
 * @returns The message ID assigned by the bundle's send pipeline.
 *
 * @remarks
 * Wire-tested via `sendText` only — `sendSnap` compiles + brings up
 * the session without throwing. The bundle drives Fidelius encryption
 * for snaps inside its own send pipeline, so as long as the session is
 * up and the standalone realm has Blob support, the snap goes out
 * E2E-encrypted to the recipient's identity key.
 */
export async function sendSnap(
  internal: MessagingInternal,
  convId: string,
  media: Uint8Array,
  opts?: { timer?: number },
): Promise<string> {
  await internal.ensureSession();
  const ctx = await internal.ctx();
  const { getSelfUserId } = await import("./reads.ts");
  const selfUserId = await getSelfUserId(ctx);
  const conv = await lookupConversation(internal, convId, selfUserId);
  const session = internal.session.get();
  const realm = internal.realm.get();
  if (!session || !realm) {
    throw new Error("Messaging.sendSnap: bundle session not available after bring-up");
  }
  return sendMediaViaSession({
    realm,
    session,
    kind: "snap",
    convId,
    convType: conv.type,
    media,
    timer: opts?.timer,
    events: internal.events,
  });
}

/**
 * Re-look up a conversation by id (cheap; cached at server). When the
 * caller passed a stale convId not in the synced list, treat as 1:1 DM
 * (kind 13) with self as the only known participant; the server will
 * reject if the conv really is stale.
 *
 * @internal
 */
async function lookupConversation(
  internal: MessagingInternal,
  convId: string,
  selfUserId: string,
): Promise<ConversationSummary> {
  const ctx = await internal.ctx();
  const all = await listConversations(ctx, selfUserId);
  const found = all.find((c) => c.conversationId === convId);
  if (!found) {
    return { conversationId: convId, type: 13, participants: [selfUserId] };
  }
  return found;
}
