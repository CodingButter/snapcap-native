/**
 * Bundle-registry resolution helpers.
 *
 * Two helpers, one shared cancel-thunk type. Every domain getter file in
 * this directory calls one of these to actually pull the live entity off
 * the sandbox; nothing else in the registry touches `getSandbox()` /
 * `getChatWreq` directly.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import { getChatWreq } from "../chat-loader.ts";

/**
 * Cancel-thunk type for store / event subscriptions — same shape as
 * Zustand's `unsubscribe`.
 *
 * Re-exported here so api files can import the cancel-thunk type from
 * the same module they import the subscriber helpers from. Kept thin
 * (`() => void`) — matches the api-side `Unsubscribe` aliases.
 *
 * @internal Bundle-layer type alias; consumers receive this shape from
 * public subscribe APIs without needing to import it directly.
 */
export type Unsubscribe = () => void;

/**
 * Reach a sandbox `globalThis.__SNAPCAP_*` symbol by key. Throws a
 * friendly error when the bundle hasn't loaded, the source-patch site
 * shifted, or the consumer called us before `client.authenticate()`.
 *
 * Accepts `string | undefined` so TODO getters (whose constant mapper
 * is still `undefined`) pass through untouched and produce a uniform
 * "not yet mapped" error at call time.
 *
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param globalKey - source-patched `__SNAPCAP_*` key, or `undefined` for TODO getters
 * @param name - human-readable getter name used in error messages
 * @returns the live bundle entity at `globalThis[globalKey]`
 * @throws when `globalKey` is undefined (TODO getter), when the bundle
 *   hasn't been loaded yet, or when the source-patch site shifted
 */
export function reach<T>(sandbox: Sandbox, globalKey: string | undefined, name: string): T {
  if (!globalKey) {
    throw new Error(`${name}: bundle export not yet mapped — see TODO in register.ts`);
  }
  const inst = sandbox.getGlobal<T>(globalKey);
  if (!inst) {
    throw new Error(
      `${name}: bundle entity not available — did you call client.authenticate() first? ` +
      `(looked for globalThis.${globalKey})`,
    );
  }
  return inst;
}

/**
 * Reach a chat-bundle webpack module by id.
 *
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param moduleId - webpack module id (string)
 * @param name - human-readable getter name used in error messages
 * @returns the module export object
 * @throws when the chat wreq lookup fails for `moduleId`
 */
export function reachModule<T>(sandbox: Sandbox, moduleId: string, name: string): T {
  try {
    return getChatWreq(sandbox)(moduleId) as T;
  } catch (err) {
    throw new Error(
      `${name}: chat wreq lookup of module ${moduleId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
