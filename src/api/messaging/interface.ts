/**
 * Public event-bus contract for the `Messaging` manager.
 *
 * Consumed by `Messaging.on(...)` and by sibling files (e.g.
 * `_media_upload.ts` — the outbound media pipeline emits the same
 * events as the inbound bridge so consumers see a uniform stream).
 */
import type { PlaintextMessage } from "../../bundle/chat/standalone/index.ts";

/**
 * Event map for `Messaging.on`.
 *
 * `message` is the only event currently wired end-to-end — it fires
 * whenever the bundle's WASM produces a plaintext message via the
 * messaging delegate. The presence events (`typing`, `viewing`, `read`)
 * are declared so consumers can subscribe today; the inbound delegate
 * slots that drive them are still being mapped — see TODO inside
 * `bringup.ts#bringUpSession`.
 */
export type MessagingEvents = {
  /** A decrypted plaintext message arrived. */
  message: (msg: PlaintextMessage) => void;
  /** Peer started typing in `convId` until `until` (ms epoch). */
  typing: (ev: { convId: string; userId: string; until: number }) => void;
  /** Peer is viewing `convId` until `until` (ms epoch). */
  viewing: (ev: { convId: string; userId: string; until: number }) => void;
  /** Peer marked `messageId` read at `at` (ms epoch). */
  read: (ev: { convId: string; userId: string; messageId: string; at: number }) => void;
};
