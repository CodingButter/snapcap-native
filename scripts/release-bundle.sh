#!/usr/bin/env bash
# release-bundle.sh — package vendor/snap-bundle/ as a tarball, publish
# it as a GitHub Release, and update package.json#snapcap.bundle so the
# SDK pins to the new snapshot.
#
# WHEN TO RUN: maintainer-only, after refreshing the bundle
# (`refresh:bundle`) and adapting the SDK to whatever Snap changed.
# Don't run otherwise — it bumps the pinned version everyone fetches.
#
# Tag format: bundle-YYYY-MM-DD (date in UTC). Override via $1 if you
# need a same-day re-release (`release:bundle bundle-2026-05-05-v2`).
#
# Requires: gh CLI authenticated (`gh auth status`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! gh auth status >/dev/null 2>&1; then
  echo "[release:bundle] gh CLI is not authenticated. Run 'gh auth login' first."
  exit 1
fi

# Compute version + tag.
DATE_UTC="$(date -u +%F)"
DEFAULT_TAG="bundle-$DATE_UTC"
TAG="${1:-$DEFAULT_TAG}"
ASSET="snap-bundle.tar.gz"

# Read repo from package.json (so this works in forks too).
REPO="$(node -e 'console.log(require("./package.json").snapcap?.bundle?.repo ?? "")')"
if [ -z "$REPO" ]; then
  echo "[release:bundle] package.json#snapcap.bundle.repo missing — populate it first."
  exit 1
fi

VENDOR_DIR="vendor/snap-bundle"
if [ ! -d "$VENDOR_DIR" ]; then
  echo "[release:bundle] $VENDOR_DIR not found — run 'refresh:bundle' first."
  exit 1
fi

TMP_TGZ="/tmp/snapcap-release-$TAG.tar.gz"

echo "[release:bundle] packaging $VENDOR_DIR → $TMP_TGZ"
# Package WITHOUT the .installed-sha256 marker — that's an install-time
# artifact, not part of the snapshot.
tar --exclude='.installed-sha256' -czf "$TMP_TGZ" -C vendor snap-bundle

SIZE="$(du -sh "$TMP_TGZ" | cut -f1)"
SHA256="$(sha256sum "$TMP_TGZ" | cut -d' ' -f1)"
FILES="$(tar -tzf "$TMP_TGZ" | wc -l)"

echo "[release:bundle] tag:   $TAG"
echo "[release:bundle] size:  $SIZE compressed"
echo "[release:bundle] files: $FILES"
echo "[release:bundle] sha:   $SHA256"

# Release notes.
NOTES_FILE="$(mktemp)"
cat >"$NOTES_FILE" <<EOF
Pinned snapshot of Snap's web bundle, captured $DATE_UTC.

This is a non-code asset release used by the SDK install flow.
\`bun run install:bundle\` reads the version pinned in
\`package.json#snapcap.bundle\` and downloads this tarball.

- $FILES files
- $SIZE compressed
- sha256: $SHA256

Replace the previously-pinned bundle when Snap pushes incompatible
changes and the SDK has been adapted. See \`scripts/release-bundle.sh\`.
EOF

# Publish to GitHub.
echo "[release:bundle] creating GitHub Release..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "Snap web bundle snapshot — $DATE_UTC" \
  --notes-file "$NOTES_FILE" \
  "$TMP_TGZ"

rm -f "$NOTES_FILE" "$TMP_TGZ"

# Update package.json#snapcap.bundle in-place.
node -e "
const fs = require('fs');
const pkg = require('./package.json');
pkg.snapcap = pkg.snapcap ?? {};
pkg.snapcap.bundle = {
  ...pkg.snapcap.bundle,
  version: '$DATE_UTC',
  release_tag: '$TAG',
  asset: '$ASSET',
  sha256: '$SHA256',
};
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "[release:bundle] ✓ done."
echo "  → GitHub Release: https://github.com/$REPO/releases/tag/$TAG"
echo "  → package.json#snapcap.bundle updated; commit it."
