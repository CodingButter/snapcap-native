/**
 * Helpers shared by `send.ts` and `presence-out.ts` for talking to the
 * standalone-chat bundle:
 *
 *   - `buildConvRef(realm, convId)` — build a realm-local
 *     `{id: Uint8Array, str: string}` envelope so the bundle's Embind
 *     cross-realm checks pass.
 *   - `fireBundleCall(fn)` — fire-and-forget invoke that swallows sync
 *     throws + async rejections, used for `convMgr.*` calls whose
 *     success callback may never fire on bot conversations.
 *
 * @internal
 */
import { uuidToBytes } from "../_helpers.ts";
import type { StandaloneChatRealm } from "../../bundle/chat/standalone/index.ts";

/**
 * Build a realm-local convRef ({id: vm-realm Uint8Array, str}) matching
 * the shape the bundle's helpers in module 56639 expect. Used by every
 * outbound call that takes a `convRef` arg.
 *
 * The bundle's cross-realm Embind checks compare `id instanceof
 * Uint8Array` against the chat-realm constructor; passing a host-realm
 * `Uint8Array` fails. Construct via `vm.runInContext("Uint8Array",
 * realm.context)` so the typed array is born in the chat realm.
 *
 * @internal
 */
export async function buildConvRef(
  realm: StandaloneChatRealm,
  convId: string,
): Promise<{ id: Uint8Array; str: string }> {
  const VmU8 = await import("node:vm").then(
    (vm) => vm.runInContext("Uint8Array", realm.context) as Uint8ArrayConstructor,
  );
  const idBytes = new VmU8(16);
  idBytes.set(uuidToBytes(convId));
  return { id: idBytes, str: convId };
}

/**
 * Invoke a bundle call (which returns a Promise that may never resolve
 * for some conv kinds), swallowing all sync throws and async
 * rejections. Fire-and-forget: the WS frame leaves synchronously inside
 * the WASM before the JS-side callback would resolve.
 *
 * @internal
 */
export function fireBundleCall(fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(
        () => {},
        () => {},
      );
    }
  } catch { /* tolerate */ }
}
