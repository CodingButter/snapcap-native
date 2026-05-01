/**
 * Boot a Snapchat-bundle-compatible browser environment in an isolated
 * Node `vm` context — a `Sandbox` whose Window holds happy-dom DOM,
 * Snap-bundle stubs (chrome, requestIdleCallback, caches, importScripts),
 * and (optionally) DataStore-backed Storage shims. Consumer's `globalThis`
 * is never modified.
 *
 * `installShims()` is idempotent: subsequent calls return the same
 * Sandbox. Bundle loaders (`chat-bundle.ts`, `kameleon.ts`) call
 * `installShims()` (or `getSandbox()`) and eval their JS via
 * `sandbox.runInContext(src)`.
 */
import { Sandbox, type SandboxOpts } from "./sandbox.ts";
import { setThrottle } from "../transport/native-fetch.ts";

let installed: Sandbox | null = null;

export type InstallShimOpts = SandboxOpts;

export function installShims(opts: InstallShimOpts = {}): Sandbox {
  if (process.env.SNAPCAP_TRACE_SHIMS) {
    const e = new Error();
    process.stderr.write(`[shims] installShims(${opts.url ?? "default"}) installed=${!!installed}\n  ${e.stack?.split("\n").slice(2, 5).join("\n  ")}\n`);
  }
  if (!installed) installed = new Sandbox(opts);
  // Last-call-wins for throttle so a re-installShims() with different
  // throttle config rebinds the gate. Safe with `undefined` (disables).
  setThrottle(opts.throttle);
  return installed;
}

export function getSandbox(): Sandbox {
  if (!installed) throw new Error("installShims() has not been called yet");
  return installed;
}

export function isShimInstalled(): boolean {
  return installed !== null;
}

export async function uninstallShims(): Promise<void> {
  installed = null;
}

// Re-export Sandbox so callers can type-import without reaching deep.
export { Sandbox } from "./sandbox.ts";
