/**
 * Chat-bundle store + RPC accessors.
 *
 * The chat-bundle Zustand store (module 94704) is the root of every
 * domain slice; the per-slice files in this directory project off
 * `chatStore(sandbox).getState()`. The `chatRpc` getter is the
 * generic gRPC escape hatch for one-off calls that don't have a typed
 * registry entry yet, and `chatWreq` is the raw webpack require for
 * bundle-plumbing helpers.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import { getChatWreq } from "../chat-loader.ts";
import type { ChatStore, NiChatRpc } from "../types/index.ts";
import { MOD_CHAT_STORE } from "./module-ids.ts";
import { G_CHAT_RPC } from "./patch-keys.ts";
import { reach, reachModule } from "./reach.ts";

/**
 * Raw chat-bundle Zustand store — exposes `subscribe`, `getState`,
 * `setState`. Chat module 94704.
 *
 * Use this when you need a live subscription to state mutations (e.g.
 * friends-list deltas) or to peek at slices the registry does not yet
 * expose a getter for. Per Phase 1B empirical finding the bundle uses
 * plain Zustand (no `subscribeWithSelector` middleware) — `subscribe`
 * is single-arg `(state, prev) => void`.
 *
 * @internal Bundle-layer accessor. Public consumers receive shaped
 * slices via the api layer rather than touching the raw store.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live Zustand {@link ChatStore}
 */
export const chatStore = (sandbox: Sandbox): ChatStore =>
  reachModule<{ M: ChatStore }>(sandbox, MOD_CHAT_STORE, "chatStore").M;

/**
 * Generic chat-side gRPC escape hatch — `Ni.rpc.unary` for arbitrary
 * AtlasGw / friending / etc. calls bypassing the typed registry.
 *
 * See {@link NiChatRpc}.
 *
 * @internal Bundle-layer accessor for one-off RPCs the typed registry
 * doesn't yet cover. Public consumers should not depend on this.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `Ni` chat RPC client
 */
export const chatRpc = (sandbox: Sandbox): NiChatRpc =>
  reach<NiChatRpc>(sandbox, G_CHAT_RPC, "chatRpc");

/**
 * Raw chat-bundle webpack require — escape hatch for code that needs to
 * walk `wreq.m` (the factory map) or call factories directly through a
 * shimmed wreq (priming, cache-cycle rewiring).
 *
 * Most consumers should reach for the typed getters above instead — this
 * is reserved for bundle-plumbing helpers (see `bundle/prime.ts`) that
 * have to bypass webpack's closure-private cache to break factory-time
 * cyclic deps.
 *
 * Re-exported here so api files don't have to import `getChatWreq`
 * directly from `./chat-loader.ts` (the architecture rule's gate point).
 *
 * @internal Bundle-plumbing escape hatch. Public consumers should never
 * touch the raw webpack require.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the chat-bundle webpack require with its `m` factory map
 */
export const chatWreq = (sandbox: Sandbox): ((id: string) => unknown) & { m: Record<string, Function> } =>
  getChatWreq(sandbox);
