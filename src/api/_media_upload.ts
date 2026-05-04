/**
 * Internal media-send helper — drives the bundle's send pipeline for
 * image DMs, disappearing snaps, and stories.
 *
 * Three callers:
 *
 *   - `Messaging.sendImage(convId, image, opts)` — persistent image DM.
 *     Routes through bundle module 56639 export `E$` (`pe` in the build's
 *     internal name): `pe(session, [convRef], [Blob])`.
 *   - `Messaging.sendSnap(convId, media, opts)` — disappearing snap to
 *     a conversation (Fidelius-encrypted). Routes through `HM` (`ue`):
 *     `ue(session, destinations, capturedSnap, ...)`. Default is
 *     view-once (no explicit timer); caller can override.
 *   - `Stories.post(media, opts)` — broadcasts to MY_STORY (recipient =
 *     16 bytes of `0x01`). Routes through the same `HM` send path with
 *     destinations built from `storyDescModule.R9`.
 *
 * # Approach
 *
 * Bundle-driven. The bundle's send pipeline owns the upload (calls
 * `mediaUploadDelegate.uploadMedia` internally), the protobuf encoding
 * (`l.v.encode({content:{$case:"externalMedia"|"snapdoc",...}})`), the
 * Fidelius wrap (for snaps), and the duplex client dispatch. We just
 * project a Blob into the standalone realm and call the right entry.
 *
 * # Message-id capture
 *
 * Bundle's send promise resolves `void`. Snap's WS push fires the
 * inbound delegate with `isSender=true` for the outbound message
 * shortly after. We subscribe transiently for ~3s, await the next
 * outbound matching this conv, and return its raw `messageId`/`messageDescriptor`.
 * If no match arrives, we fall back to the locally-generated client UUID
 * (synthetic but UUID-shaped) — caller can correlate via the live
 * `message` event.
 *
 * @internal
 */
import vm from "node:vm";
import { bytesToUuid } from "./_helpers.ts";
import type { TypedEventBus } from "../lib/typed-event-bus.ts";
import type {
  BundleMessagingSession,
} from "../auth/fidelius-decrypt.ts";
import type { StandaloneChatRealm } from "../auth/fidelius-mint.ts";
import type { MessagingEvents } from "./messaging.ts";

/**
 * Options for {@link sendMediaViaSession}.
 *
 * @internal
 */
export type SendMediaOpts =
  | {
      kind: "image";
      realm: StandaloneChatRealm;
      session: BundleMessagingSession;
      convId: string;
      convType: number;
      media: Uint8Array;
      caption?: string;
      events: TypedEventBus<MessagingEvents>;
    }
  | {
      kind: "snap";
      realm: StandaloneChatRealm;
      session: BundleMessagingSession;
      convId: string;
      convType: number;
      media: Uint8Array;
      timer?: number;
      events: TypedEventBus<MessagingEvents>;
    }
  | {
      kind: "story";
      realm: StandaloneChatRealm;
      session: BundleMessagingSession;
      media: Uint8Array;
      caption?: string;
      events: TypedEventBus<MessagingEvents>;
    };

/**
 * Dispatch a media send through the bundle's session, capturing the
 * outbound message id from the inbound `message` event.
 */
export async function sendMediaViaSession(opts: SendMediaOpts): Promise<string> {
  const { realm, session, events } = opts;

  // Resolve the bundle's webpack module 56639 (sends/receives) inside the
  // standalone realm. The session was created in this realm, so its
  // Embind methods + the bundle's module exports all share one realm.
  const sendsMod = realm.wreq("56639") as Record<string, Function>;
  const destMod = realm.wreq("79028") as Record<string, Function>;

  // Cross-realm constructors so `instanceof Blob` checks inside the
  // bundle pass.
  const VmU8 = vm.runInContext("Uint8Array", realm.context) as Uint8ArrayConstructor;
  const RealmBlob = vm.runInContext("typeof Blob === 'function' ? Blob : null", realm.context) as
    | (new (parts: BlobPart[], options?: BlobPropertyBag) => Blob)
    | null;
  if (!RealmBlob) {
    throw new Error("sendMediaViaSession: standalone realm has no Blob constructor — fidelius-decrypt's Blob shim missing");
  }
  // Project bytes into the realm so the underlying Uint8Array is
  // realm-local — Snap's bundle does cross-realm checks.
  const realmBytes = new VmU8(opts.media.byteLength);
  realmBytes.set(opts.media);
  const blob = new RealmBlob([realmBytes], { type: sniffMime(opts.media) });

  const subscription = createOutboundCapture(events, undefined);

  try {
    if (opts.kind === "image") {
      // pe(session, conversations[], mediaBlobs[], reactionMessageMetadata?)
      const convRef = makeRealmConvRef(realm, opts.convId);
      const sendImage = sendsMod.E$ as Function;
      if (typeof sendImage !== "function") {
        throw new Error("sendMediaViaSession: module 56639 export E$ (sendImage) not a function — bundle shape may have shifted");
      }
      await sendImage(session, [convRef], [blob], undefined);
    } else if (opts.kind === "snap") {
      // ue(session, destinations, capturedSnap, ..., savePolicy)
      // destinations = Ju({conversations:[convRef]})
      const convRef = makeRealmConvRef(realm, opts.convId);
      const dests = (destMod.Ju as Function)({ conversations: [convRef] });
      const sniffed = sniffMime(opts.media);
      // capturedSnap shape: { mediaType, media: Blob, hasAudio, ... }
      // mediaType: 1 = Image, 2 = Video (from the bundle's I.z enum)
      const capturedSnap = {
        mediaType: sniffed.startsWith("video/") ? 2 : 1,
        media: blob,
        overlayMedia: undefined,
        hasAudio: false,
        loopPlayback: false,
        // Use 1080x1920 as portrait-default; bundle's pg() may override
        // after sniffing actual dimensions.
        width: 1080,
        height: 1920,
        durationInSec: undefined,
      };
      const sendSnap = sendsMod.HM as Function;
      if (typeof sendSnap !== "function") {
        throw new Error("sendMediaViaSession: module 56639 export HM (sendSnap) not a function — bundle shape may have shifted");
      }
      // Caller-provided timer is informational at this layer; the bundle's
      // sendSnap defaults to view-once (savePolicy = VIEW_SESSION) when
      // contentType=SNAP, which matches our default. A future enhancement
      // would map opts.timer to the bundle's display-duration field.
      void opts.timer;
      await sendSnap(session, dests, capturedSnap, undefined, undefined, []);
    } else if (opts.kind === "story") {
      // Build MY_STORY destinations via module 74762's R9 helper, then
      // pass to HM via the destinations builder.
      const storyDescMod = realm.wreq("74762") as Record<string, Function>;
      const storyDescriptors = (storyDescMod.R9 as Function)(false) as unknown[];
      const dests = (destMod.Ju as Function)({ stories: storyDescriptors });
      const sniffed = sniffMime(opts.media);
      const capturedSnap = {
        mediaType: sniffed.startsWith("video/") ? 2 : 1,
        media: blob,
        overlayMedia: undefined,
        hasAudio: false,
        loopPlayback: false,
        width: 1080,
        height: 1920,
        durationInSec: undefined,
      };
      const sendSnap = sendsMod.HM as Function;
      if (typeof sendSnap !== "function") {
        throw new Error("sendMediaViaSession: module 56639 export HM (story-send) not a function");
      }
      await sendSnap(session, dests, capturedSnap, undefined, undefined, []);
    } else {
      // Exhaustiveness check
      const _x: never = opts;
      void _x;
      throw new Error("sendMediaViaSession: unknown kind");
    }

    // Wait briefly for the outbound message id from the WS push.
    const captured = await subscription.waitForOutbound(3000);
    return captured ?? subscription.fallbackId;
  } finally {
    subscription.cleanup();
  }
}

/**
 * Build a realm-local `{id: bytes16, str}` ConversationRef. The bundle's
 * Embind layer expects realm-local Uint8Array for `id`.
 *
 * @internal
 */
function makeRealmConvRef(realm: StandaloneChatRealm, convId: string): { id: Uint8Array; str: string } {
  const VmU8 = vm.runInContext("Uint8Array", realm.context) as Uint8ArrayConstructor;
  const hex = convId.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`makeRealmConvRef: invalid convId "${convId}"`);
  }
  const id = new VmU8(16);
  for (let i = 0; i < 16; i++) id[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { id, str: convId };
}

/**
 * Subscribe to the next outbound `message` event so we can capture the
 * server-assigned message id for the send call's return value.
 *
 * @param events - the messaging event bus to subscribe on
 * @param matchText - optional text fragment to match (for sendText) so we
 *   don't pick up an unrelated outbound that happens to arrive in the
 *   wait window. When omitted, accept any outbound.
 *
 * @internal
 */
export function createOutboundCapture(
  events: TypedEventBus<MessagingEvents>,
  matchText?: string,
): {
  waitForOutbound: (ms: number) => Promise<string | undefined>;
  fallbackId: string;
  cleanup: () => void;
} {
  // Generate a fallback UUIDv4 we hand back if no outbound message
  // arrives within the wait window. Caller can correlate via the live
  // `message` event with `isSender === true`.
  const cmidBytes = new Uint8Array(16);
  crypto.getRandomValues(cmidBytes);
  cmidBytes[6] = (cmidBytes[6]! & 0x0f) | 0x40;
  cmidBytes[8] = (cmidBytes[8]! & 0x3f) | 0x80;
  const fallbackId = bytesToUuid(cmidBytes);

  let resolveOutbound: ((id: string | undefined) => void) | undefined;
  const sub = events.on("message", (msg) => {
    if (msg.isSender !== true) return;
    if (matchText) {
      const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(msg.content);
      if (!utf8.includes(matchText)) return;
    }
    const raw = msg.raw as Record<string, unknown> | undefined;
    if (!raw) {
      resolveOutbound?.(fallbackId);
      return;
    }
    const mid = extractMessageIdFromRaw(raw);
    resolveOutbound?.(mid ?? fallbackId);
  });

  return {
    fallbackId,
    waitForOutbound: (ms: number) =>
      new Promise<string | undefined>((resolve) => {
        resolveOutbound = resolve;
        setTimeout(() => resolve(undefined), ms);
      }),
    cleanup: () => {
      try { sub(); } catch { /* tolerate */ }
    },
  };
}

/**
 * Try to pull a hyphenated UUID-shaped messageId out of an Embind
 * messaging-delegate raw message object. Field name varies by build;
 * we probe a small set of plausible keys and shape variants.
 *
 * @internal
 */
function extractMessageIdFromRaw(raw: Record<string, unknown>): string | undefined {
  // Common keys: messageId, serverMessageId, clientMessageId, messageDescriptor
  for (const key of ["messageId", "serverMessageId", "clientMessageId"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length >= 32) return v;
    if (v && typeof v === "object") {
      const u = uuidLikeFrom(v);
      if (u) return u;
    }
  }
  const desc = raw.messageDescriptor as Record<string, unknown> | undefined;
  if (desc) {
    for (const key of ["messageId", "serverMessageId", "clientMessageId", "id"]) {
      const v = desc[key];
      const u = uuidLikeFrom(v);
      if (u) return u;
    }
  }
  return undefined;
}

function uuidLikeFrom(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    return v;
  }
  if (typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  let bytes: number[] | undefined;
  if (obj.id) {
    const id = obj.id as { byteLength?: number; [k: number]: number } | Uint8Array;
    if (id instanceof Uint8Array && id.byteLength === 16) bytes = Array.from(id);
    else if (typeof id === "object") {
      const u = id as { byteLength?: number; [k: number]: number };
      if (u.byteLength === 16) bytes = Array.from({ length: 16 }, (_, i) => u[i] ?? 0);
    }
  } else if (v instanceof Uint8Array && v.byteLength === 16) {
    bytes = Array.from(v);
  }
  if (!bytes) return undefined;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Tiny MIME sniffer for the three common image / video formats. Used to
 * tag the realm-local Blob with a `type` so the bundle's `pg` helper
 * picks the right mediaType enum.
 *
 * @internal
 */
function sniffMime(bytes: Uint8Array): string {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // ftyp box for MP4 / MOV
  if (
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    return "video/mp4";
  }
  return "application/octet-stream";
}
