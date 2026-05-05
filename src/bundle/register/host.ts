/**
 * Host / transport bundle accessors — host constants, the bundle's
 * default-authed fetch helper, and the AtlasGw class + natural instance.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type {
  AtlasGwClassCtor,
  AtlasGwClient,
  DefaultAuthedFetchModule,
  HostModule,
} from "../types/index.ts";
import { MOD_ATLAS_CLASS, MOD_DEFAULT_AUTHED_FETCH, MOD_HOST } from "./module-ids.ts";
import { G_ATLAS_CLIENT } from "./patch-keys.ts";
import { reach, reachModule } from "./reach.ts";

/**
 * Host constants — chat module 41359 (`r5` is `https://web.snapchat.com`).
 *
 * See {@link HostModule}.
 *
 * @internal Bundle-layer accessor. Used by the api layer when building
 * same-origin URLs.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-41359 export
 */
export const hostModule = (sandbox: Sandbox): HostModule =>
  reachModule<HostModule>(sandbox, MOD_HOST, "hostModule");

/**
 * Default-authed fetch helper — chat module 34010.
 *
 * `s(url, opts)` is the bundle's same-origin POST helper with bearer +
 * cookies attached the way the SPA does. `Friends.search` routes the
 * `/search/search` POST through it. See {@link DefaultAuthedFetchModule}.
 *
 * @internal Bundle-layer accessor. Public consumers should not call the
 * bundle's authed-fetch directly — the api layer wraps it.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live module-34010 export with its `s` POST helper
 * @throws when the module's shape has shifted (no `s` function present)
 */
export const defaultAuthedFetch = (sandbox: Sandbox): DefaultAuthedFetchModule => {
  const mod = reachModule<Partial<DefaultAuthedFetchModule>>(sandbox, MOD_DEFAULT_AUTHED_FETCH, "defaultAuthedFetch");
  if (!mod || typeof mod.s !== "function") {
    throw new Error(`defaultAuthedFetch: chat module ${MOD_DEFAULT_AUTHED_FETCH} shape shifted`);
  }
  return mod as DefaultAuthedFetchModule;
};

/**
 * AtlasGw class — chat module 74052.
 *
 * Consumers wrap with their own `{unary}` rpc transport. Walks the
 * module's exports to find the class whose prototype has
 * `SyncFriendData`. Switch to the natural instance once `__SNAPCAP_ATLAS`
 * lands (see {@link atlasClient}).
 *
 * @internal Bundle-layer accessor. Prefer {@link atlasClient} for the
 * natural per-bundle instance.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live AtlasGw class constructor
 * @throws when the AtlasGw class can't be located in module 74052
 *   (export shape may have shifted)
 */
export const atlasGwClass = (sandbox: Sandbox): AtlasGwClassCtor => {
  const exp = reachModule<Record<string, unknown>>(sandbox, MOD_ATLAS_CLASS, "atlasGwClass");
  for (const k of Object.keys(exp)) {
    const v = exp[k];
    if (typeof v !== "function") continue;
    const proto = (v as { prototype?: Record<string, unknown> }).prototype;
    if (proto && typeof proto.SyncFriendData === "function") {
      return v as AtlasGwClassCtor;
    }
  }
  throw new Error("atlasGwClass: AtlasGw class not found in module 74052 (export shape may have shifted)");
};

/**
 * AtlasGw natural instance — chat main byte ~6940575 closure-private `A`,
 * source-patched as `__SNAPCAP_ATLAS`.
 *
 * Prefer this over {@link atlasGwClass} — it's the same per-bundle `A`
 * instance the SPA uses, with `rpc.unary` wired to the bundle's own
 * `default-authed-fetch` (so bearer + cookies are attached the way the
 * SPA does).
 *
 * @remarks AtlasGw has no fuzzy user-search method. `friends.search()`
 * continues to use the closure-private `HY/jY` codecs +
 * {@link defaultAuthedFetch} because the bundle's own search path
 * (`Yz`, byte ~1435000) is REST POST to `/search/search`, not a gRPC
 * call on AtlasGw.
 *
 * @internal Bundle-layer accessor. Public consumers reach AtlasGw
 * methods via `src/api/friends.ts`.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `A` AtlasGw client instance
 */
export const atlasClient = (sandbox: Sandbox): AtlasGwClient =>
  reach<AtlasGwClient>(sandbox, G_ATLAS_CLIENT, "atlasClient");
