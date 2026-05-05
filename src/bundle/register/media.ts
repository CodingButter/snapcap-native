/**
 * Media-domain bundle accessors — the `Fi` upload delegate, the
 * destinations builder, and the story-descriptor helper module.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { DestinationsModule, FiUpload, StoryDescModule } from "../types.ts";
import { MOD_DESTINATIONS, MOD_STORY_DESC } from "./module-ids.ts";
import { G_FI_UPLOAD } from "./patch-keys.ts";
import { reach, reachModule } from "./reach.ts";

/**
 * Media upload delegate — `Fi` (chat module 76877).
 *
 * `uploadMedia` / `uploadMediaReferences` for direct upload control;
 * sends/snaps usually drive uploads as a side-effect. See {@link FiUpload}.
 *
 * @internal Bundle-layer accessor. Public consumers reach uploads via
 * higher-level send APIs (see `src/api/messaging.ts`, `src/api/media.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `Fi` mediaUploadDelegate
 */
export const uploadDelegate = (sandbox: Sandbox): FiUpload =>
  reach<FiUpload>(sandbox, G_FI_UPLOAD, "uploadDelegate");

/**
 * Destinations builder — chat module 79028 `Ju` builds a
 * `SnapDestinations` envelope from a partial.
 *
 * See {@link DestinationsModule}.
 *
 * @internal Bundle-layer accessor. Used by the api layer when building
 * `sendSnap` / `postStory` destinations.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-79028 export
 */
export const destinationsModule = (sandbox: Sandbox): DestinationsModule =>
  reachModule<DestinationsModule>(sandbox, MOD_DESTINATIONS, "destinationsModule");

/**
 * Story descriptor helpers — chat module 74762.
 *
 * `R9` returns the single-element MY_STORY descriptor array; `ge`
 * converts each descriptor to its server-side destination shape. See
 * {@link StoryDescModule}.
 *
 * @internal Bundle-layer accessor. Used by the api layer's `postStory`
 * pipeline.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-74762 export
 */
export const storyDescModule = (sandbox: Sandbox): StoryDescModule =>
  reachModule<StoryDescModule>(sandbox, MOD_STORY_DESC, "storyDescModule");
