#!/usr/bin/env bash
# install-bundle.sh — fetch the pinned Snap bundle from a GitHub Release.
#
# Reads `package.json#snapcap.bundle` for:
#   - release_tag      (e.g. "bundle-2026-05-05")
#   - asset            (e.g. "snap-bundle.tar.gz")
#   - sha256           (verifies the download wasn't tampered with)
#   - repo             (e.g. "CodingButter/snapcap-native")
#
# Why pinned vs. fresh: Snap pushes bundle changes continuously; if the
# install pulled latest from their CDN, every change could break our SDK
# even when our code is unchanged. The pinned snapshot pairs a specific
# bundle version with the SDK version that was tested against it. When
# Snap breaks us, the maintainer runs `refresh:bundle` + `release:bundle`
# to publish a new compatible pair.
#
# Idempotent: if vendor/snap-bundle/ already matches the pinned sha,
# does nothing. Pass --force to redownload anyway.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Read pin from package.json. Use `node` (or bun) to parse JSON robustly
# rather than awk/sed.
read -r RELEASE_TAG ASSET SHA256 REPO <<<"$(node -e '
const pkg = require("./package.json");
const b = pkg.snapcap?.bundle;
if (!b) { console.error("package.json#snapcap.bundle missing"); process.exit(1); }
process.stdout.write(`${b.release_tag} ${b.asset} ${b.sha256} ${b.repo}`);
')"

VENDOR_DIR="vendor/snap-bundle"
ASSET_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET}"
TMP_TGZ="/tmp/snapcap-bundle-${RELEASE_TAG}.tar.gz"

# Fast-path: already installed?
if [ -d "$VENDOR_DIR" ] && [ "$FORCE" = "0" ]; then
  # Re-tar in place + sha-check would be heavy. Instead use a marker file
  # that records the installed sha. If it matches, skip.
  MARKER="$VENDOR_DIR/.installed-sha256"
  if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$SHA256" ]; then
    echo "[install:bundle] vendor already at pinned sha — nothing to do."
    echo "[install:bundle]   tag=$RELEASE_TAG  sha=$SHA256"
    echo "[install:bundle] (use --force to redownload)"
    exit 0
  fi
fi

echo "[install:bundle] pinned: $RELEASE_TAG ($ASSET)"
echo "[install:bundle] from:   $ASSET_URL"

# Download.
curl -fsSL --progress-bar -o "$TMP_TGZ" "$ASSET_URL"

# Verify sha256.
ACTUAL_SHA="$(sha256sum "$TMP_TGZ" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA" != "$SHA256" ]; then
  echo "[install:bundle] FATAL: sha256 mismatch."
  echo "  expected: $SHA256"
  echo "  actual:   $ACTUAL_SHA"
  echo "  This means either (a) the GitHub Release asset was modified after"
  echo "  publication, (b) package.json#snapcap.bundle.sha256 is stale, or"
  echo "  (c) network corruption. Inspect $TMP_TGZ manually."
  exit 1
fi

# Wipe + extract.
rm -rf "$VENDOR_DIR"
mkdir -p vendor
tar -xzf "$TMP_TGZ" -C vendor

# Stamp the installed sha so the fast-path works next time.
echo "$SHA256" > "$VENDOR_DIR/.installed-sha256"

# Clean up.
rm -f "$TMP_TGZ"

FILES="$(find "$VENDOR_DIR" -type f | wc -l)"
SIZE="$(du -sh "$VENDOR_DIR" | cut -f1)"
echo "[install:bundle] ✓ extracted to $VENDOR_DIR ($FILES files, $SIZE)"
