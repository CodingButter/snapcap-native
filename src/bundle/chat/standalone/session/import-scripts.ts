/**
 * `importScripts` shim for the standalone realm.
 *
 * The f16f14e3 worker chunk uses `self.importScripts(url)` to dynamically
 * pull in sibling chunks at session bring-up. We can't fetch from the
 * Snap CDN at runtime (cookie / bearer / TLS-fingerprint hassle), so the
 * shim instead routes known suffix patterns to local files in
 * `vendor/snap-bundle/cf-st.sc-cdn.net/dw/`.
 *
 * The KNOWN_CHUNKS table is built at install time per-session because the
 * paths are derived from the same `bundleDir` the caller's setup uses.
 *
 * @internal
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Install an `importScripts` polyfill on a standalone-realm globalThis.
 * Maps URL suffixes to vendor file paths; unknown URLs log a warning and
 * are silently skipped (most are optional analytics chunks).
 */
export function installImportScripts(opts: {
  realmGlobal: Record<string, unknown>;
  context: vm.Context;
  /** Map of URL-suffix → local file path. Pass an absolute path. */
  knownChunks: Record<string, string>;
  log: (line: string) => void;
}): void {
  const { realmGlobal, context, knownChunks, log } = opts;
  realmGlobal.importScripts = (...urls: string[]): void => {
    for (const url of urls) {
      let p: string | undefined;
      for (const key in knownChunks) {
        if (url.endsWith(key)) {
          p = knownChunks[key]!;
          break;
        }
      }
      if (!p) {
        log(`[importScripts] WARN unknown URL ${url}`);
        continue;
      }
      const src = readFileSync(p, "utf8");
      vm.runInContext(src, context, { filename: p.split("/").pop()! });
    }
  };
}
