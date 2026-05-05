/**
 * Source-patch the f16f14e3 worker chunk to expose `En` (the messaging
 * engine), `un` (the chunk's `unmoduleEnv` / wasm holder), and `pn` (the
 * setter helper used to inject the wasm Module + fatal reporter) on
 * `globalThis` BEFORE the chunk's `z(En)` Comlink call hands `En` off to
 * the worker bridge.
 *
 * The patch site `wasm_worker_initialized"}),z(En)` is load-bearing for
 * future bundle-remap work — when Snap rebuilds, this string + the
 * `__SNAPCAP_*` slot names must be re-located. See `bundle/register/`
 * for the broader pattern.
 *
 * @internal
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * The exact source substring we splice into. Must match a single site;
 * the bundle's `wasm_worker_initialized` analytics token gives us a
 * stable anchor that survives most minifier passes.
 */
export const PATCH_SITE = `wasm_worker_initialized"}),z(En)`;

/**
 * Read the f16f14e3 chunk, splice in the `__SNAPCAP_*` exposures, IIFE-
 * wrap (with `\n` around the source — the chunk ends in a sourceMappingURL
 * line comment), and eval into the standalone realm.
 *
 * Throws if the patch site has shifted (Snap rebuilt the bundle).
 *
 * @internal
 */
export function loadPatchedChunk(opts: {
  chunkPath: string;
  context: vm.Context;
  log: (line: string) => void;
}): void {
  const { chunkPath, context, log } = opts;
  let chunkSrc = readFileSync(chunkPath, "utf8");
  if (!chunkSrc.includes(PATCH_SITE)) {
    throw new Error(
      `setupBundleSession: f16f14e3 chunk patch site \`wasm_worker_initialized"}),z(En)\` missing — bundle version may have shifted`,
    );
  }
  chunkSrc = chunkSrc.replace(
    PATCH_SITE,
    `wasm_worker_initialized"}),globalThis.__SNAPCAP_EN=En,globalThis.__SNAPCAP_UN=un,globalThis.__SNAPCAP_PN=pn,z(En)`,
  );

  const wrappedChunk =
    `(function(module, exports, require) {\n` +
    chunkSrc +
    `\n})({ exports: {} }, {}, function() { throw new Error("require not available (f16f14e3 chunk)"); });`;

  try {
    vm.runInContext(wrappedChunk, context, { filename: "f16f14e3-patched.js" });
  } catch (e) {
    log(`[setupBundleSession] chunk run threw: ${(e as Error).message}`);
  }
}
