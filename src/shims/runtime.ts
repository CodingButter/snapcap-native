/**
 * Boot a Snapchat-bundle-compatible browser environment in an isolated
 * Node `vm` context — a {@link Sandbox} whose Window holds happy-dom DOM,
 * Snap-bundle stubs (chrome, requestIdleCallback, caches, importScripts),
 * and (optionally) DataStore-backed Storage shims. Consumer's `globalThis`
 * is never modified.
 *
 * @remarks Historical note — this module used to expose
 * `installShims()` / `getSandbox()` / `uninstallShims()` / `isShimInstalled()`
 * as a process-singleton convenience. Those were removed because the
 * cached singleton was incompatible with multi-tenant `SnapcapClient`
 * usage (each client must own its own `Sandbox`). Construct a fresh
 * `Sandbox` per use site:
 *
 * ```ts
 * import { Sandbox } from "@snapcap/native";
 *
 * const sandbox = new Sandbox({ dataStore });
 * sandbox.runInContext(src, "<filename>");
 * ```
 *
 * Sandbox-consuming SDK helpers (`idbGet`/`idbPut`/`idbDelete`,
 * bundle loaders, etc.) accept a {@link Sandbox} instance as their first
 * argument so callers can route them at the per-instance Sandbox they
 * already own.
 */
export { Sandbox, type SandboxOpts } from "./sandbox.ts";

/**
 * Options accepted by the {@link Sandbox} constructor — alias retained for
 * backward-compatibility with code that imported `InstallShimOpts`.
 *
 * @internal
 */
export type { SandboxOpts as InstallShimOpts } from "./sandbox.ts";
