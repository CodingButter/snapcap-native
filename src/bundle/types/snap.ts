/**
 * Snap-send wire shapes — the destinations envelope, captured-media
 * payload, and the two bundle modules that build / convert them
 * (`Ju` destinations builder, `R9`/`ge` story-descriptor pair).
 *
 * Also hosts the placeholder `StoryManager` interface — it lives on the
 * WASM messaging session and isn't surfaced as a registry entry yet, but
 * the eventual `__SNAPCAP_STORY_MANAGER` source-patch will reach for
 * exactly this shape.
 */
import type { ConversationRef } from "./shared.ts";

/**
 * Destinations envelope returned by the bundle's `Ju` builder (module 79028)
 * and consumed by `sendSnap`. `conversations` are `ConversationRef`s
 * (bytes16-wrapped); `stories` / `phoneNumbers` / `massSnaps` are
 * bundle-internal struct shapes the SDK passes through opaquely.
 *
 * @internal Bundle wire-format type.
 */
export type SnapDestinations = {
  conversations: ConversationRef[];
  stories: unknown[];
  phoneNumbers: unknown[];
  massSnaps: unknown[];
};

/**
 * Captured-media payload accepted by the bundle's `sendSnap` entry.
 *
 * @internal Bundle wire-format type.
 */
export type CapturedSnap = {
  mediaType: number;
  media: unknown;
  overlayMedia?: unknown;
  hasAudio?: boolean;
  loopPlayback?: boolean;
  width?: number;
  height?: number;
  durationInSec?: number;
};

/**
 * Module 79028 — `Ju` builds a `SnapDestinations` envelope from a partial.
 *
 * @internal Bundle wire-format type.
 */
export interface DestinationsModule {
  Ju(input: { conversations?: ConversationRef[]; stories?: unknown[]; massSnaps?: unknown[]; phoneNumbers?: unknown[] }): SnapDestinations;
}

/**
 * Module 74762 — `R9` returns the single-element MY_STORY descriptor
 * array; `ge` converts each descriptor to its server-side destination
 * shape.
 *
 * @internal Bundle wire-format type.
 */
export interface StoryDescModule {
  R9(friendsOnly?: boolean): unknown[];
  ge(descriptor: unknown): unknown;
}

/**
 * StoryManager — placeholder. Lives on the WASM messaging session as
 * `getStoryManager()`. Needs an Embind trace plus a source-patch to
 * surface as `__SNAPCAP_STORY_MANAGER`.
 *
 * @internal Bundle wire-format type (TODO).
 */
export interface StoryManager {
  getMyStorySnaps?: () => Promise<unknown>;
  viewStory?: (storyId: unknown, snapId?: unknown) => Promise<unknown>;
}
