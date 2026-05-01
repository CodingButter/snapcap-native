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

let installed: Sandbox | null = null;

/**
 * Options accepted by {@link installShims} — alias for {@link SandboxOpts}.
 *
 * @internal
 */
export type InstallShimOpts = SandboxOpts;

/**
 * Construct (or return the cached) process-singleton {@link Sandbox} that
 * the bundle loaders run code inside. Idempotent — repeated calls return
 * the same instance.
 *
 * @internal
 * @param opts - sandbox configuration; see {@link SandboxOpts}
 * @returns the singleton {@link Sandbox}
 */
export function installShims(opts: InstallShimOpts = {}): Sandbox {
  if (process.env.SNAPCAP_TRACE_SHIMS) {
    const e = new Error();
    process.stderr.write(`[shims] installShims(${opts.url ?? "default"}) installed=${!!installed}\n  ${e.stack?.split("\n").slice(2, 5).join("\n  ")}\n`);
  }
  // NOTE: this still returns a process-singleton today; the multi-instance
  // refactor (this branch) will replace this with a fresh Sandbox per call.
  // Throttle config lives on the Sandbox itself now (see Sandbox#throttleGate),
  // so installShims no longer needs to thread throttle anywhere.
  if (!installed) installed = new Sandbox(opts);
  return installed;
}

/**
 * Read back the singleton {@link Sandbox} previously created by
 * {@link installShims}.
 *
 * @internal
 * @throws if {@link installShims} has not yet been called
 */
export function getSandbox(): Sandbox {
  if (!installed) throw new Error("installShims() has not been called yet");
  return installed;
}

/**
 * Whether {@link installShims} has been called this process.
 *
 * @internal
 */
export function isShimInstalled(): boolean {
  return installed !== null;
}

/**
 * Drop the singleton reference so the next {@link installShims} returns a
 * fresh {@link Sandbox}. Used by tests; production code should not call this.
 *
 * @internal
 */
export async function uninstallShims(): Promise<void> {
  installed = null;
}

// Re-export Sandbox so callers can type-import without reaching deep.
export { Sandbox } from "./sandbox.ts";
