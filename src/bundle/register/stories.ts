/**
 * Stories-domain bundle accessors — TODO getters whose source-patch
 * sites haven't been mapped yet. Both throw the standard "not yet
 * mapped" error at call time via {@link reach}.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type { StoryManager, UserInfoClient } from "../types.ts";
import { G_STORY_MANAGER, G_USER_INFO_CLIENT } from "./patch-keys.ts";
import { reach } from "./reach.ts";

/**
 * UserInfo / Self client — placeholder.
 *
 * @remarks TODO — no dedicated RPC located yet; investigate AtlasGw
 * `GetSnapchatterPublicInfo` and any `GetSelf` candidate.
 *
 * @internal Bundle-layer accessor (TODO).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live UserInfo client (when mapped)
 * @throws always, until the source-patch lands
 */
export const userInfoClient = (sandbox: Sandbox): UserInfoClient =>
  reach<UserInfoClient>(sandbox, G_USER_INFO_CLIENT, "userInfoClient");

/**
 * StoryManager — `getStoryManager()` on the WASM session.
 *
 * @remarks TODO — needs an Embind trace + a source-patch to surface as
 * `__SNAPCAP_STORY_MANAGER`.
 *
 * @internal Bundle-layer accessor (TODO).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live StoryManager (when mapped)
 * @throws always, until the source-patch lands
 */
export const storyManager = (sandbox: Sandbox): StoryManager =>
  reach<StoryManager>(sandbox, G_STORY_MANAGER, "storyManager");
