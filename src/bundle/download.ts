/**
 * Bundle bootstrap: ensure vendor/snap-bundle/ is populated before kameleon
 * tries to load it.
 *
 * Why this exists: we don't ship Snap's JavaScript and WASM in the npm
 * tarball — that would be a redistribution problem and bloat the install
 * by ~7 MB. Instead, the first time a consumer calls
 * SnapcapClient.fromCredentials() (or any other entry point that reaches
 * bootKameleon), we shell out to scripts/download-bundle.sh to fetch
 * everything fresh from Snap's own CDNs.
 *
 * The download is one-time per install. Subsequent boots find the files
 * already there and skip the fetch. If Snap rotates the bundle and a key
 * file disappears, this triggers a re-download.
 *
 * Requires: bash, curl, python3 in PATH. All standard on Linux/macOS
 * server installs. Windows users need WSL or equivalent.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let ensured = false; // MULTI-INSTANCE-SAFE: bundle download is process-wide and idempotent (vendor/ files are the source of truth)

/**
 * Idempotent bundle bootstrap — ensure `vendor/snap-bundle/` is
 * populated before kameleon (or any chat-bundle loader) tries to load
 * it.
 *
 * Cheap fast path: if `hasUsableBundle(bundleDir)` returns `true`, sets
 * the process-wide `ensured` flag and returns. Otherwise shells out to
 * `scripts/download-bundle.sh` once (~30s, one-time per install) and
 * verifies the result.
 *
 * @internal Bundle-layer bootstrap. Public consumers don't call this
 * directly — it's invoked from `bootKameleon` / chat-bundle loaders.
 * @param bundleDir - destination root, typically `vendor/snap-bundle`
 * @throws when the download script can't be located, exits non-zero, or
 *   leaves the bundle still incomplete after running
 */
export async function ensureBundle(bundleDir: string): Promise<void> {
  if (ensured) return;
  if (hasUsableBundle(bundleDir)) {
    ensured = true;
    return;
  }

  const script = locateDownloadScript();
  if (!script) {
    throw new Error(
      `Snap bundle missing at ${bundleDir}, and download-bundle.sh not found in package. ` +
      `If you're developing the SDK locally, run: pnpm download:bundle`,
    );
  }

  console.log(`[snapcap] bundle missing at ${bundleDir} — downloading from Snap (one-time, ~30s)…`);
  const code = await spawnAndWait("bash", [script], {
    OUT_DIR: bundleDir,
  });
  if (code !== 0) {
    throw new Error(
      `download-bundle.sh exited with code ${code}. ` +
      `Verify bash, curl, and python3 are installed; rerun manually with OUT_DIR=${bundleDir} bash ${script} to debug.`,
    );
  }
  if (!hasUsableBundle(bundleDir)) {
    throw new Error(
      `download-bundle.sh succeeded but kameleon.wasm is still missing at ${bundleDir}. ` +
      `Snap's bundle layout may have rotated — rerun extract-chunk-urls.py to refresh URL list.`,
    );
  }
  ensured = true;
}

/**
 * Coarse "is the bundle there" check. We look for two markers that span
 * both halves of what we need: a kameleon.*.wasm in the accounts media
 * dir, and any *.js in cf-st.sc-cdn.net/dw/. If both exist, we assume
 * the rest is in place; if either is missing, refetch.
 */
function hasUsableBundle(bundleDir: string): boolean {
  if (!existsSync(bundleDir)) return false;
  const mediaDir = join(bundleDir, "static.snapchat.com/accounts/_next/static/media");
  if (!existsSync(mediaDir)) return false;
  const hasKameleon = readdirSync(mediaDir).some(
    (f) => f.startsWith("kameleon.") && f.endsWith(".wasm"),
  );
  if (!hasKameleon) return false;
  const chatDir = join(bundleDir, "cf-st.sc-cdn.net/dw");
  if (!existsSync(chatDir)) return false;
  const hasChatJs = readdirSync(chatDir).some(
    (f) => f.endsWith(".js") && statSync(join(chatDir, f)).size > 100_000,
  );
  return hasChatJs;
}

/**
 * The download script lives next to package.json under scripts/. From this
 * file's location:
 *   - dev (src/auth/ensure-bundle.ts):  ../../scripts/download-bundle.sh
 *   - built (dist/auth/ensure-bundle.js): same relative path
 * Both resolve to <packageRoot>/scripts/download-bundle.sh.
 */
function locateDownloadScript(): string | null {
  const here = fileURLToPath(import.meta.url);
  const candidate = join(here, "..", "..", "..", "scripts", "download-bundle.sh");
  return existsSync(candidate) ? candidate : null;
}

function spawnAndWait(cmd: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? -1));
  });
}
