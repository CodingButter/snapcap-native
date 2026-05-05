#!/usr/bin/env bash
# worktree-init.sh — bootstrap a fresh worktree for testing.
#
# A git worktree only contains tracked files. node_modules,
# vendor/snap-bundle/, .snapcap-smoke.json, and .tmp/auth/ are all
# gitignored — so a freshly-created worktree can't run lint, typecheck,
# or live tests without setup. This script handles all of that.
#
# Usage:
#   bash scripts/worktree-init.sh [VENDOR_PATH]
#
# Two modes:
#
#   1. With VENDOR_PATH (fast path, zero network):
#        bash scripts/worktree-init.sh /home/me/snapcap/SnapSDK/vendor
#      Symlinks vendor/snap-bundle from the given path. Instant. The
#      symlink shares disk with the source, so updates to either side
#      are visible to the other. Use this when running an agent in a
#      sibling worktree of the main repo.
#
#   2. Without VENDOR_PATH (network download):
#        bash scripts/worktree-init.sh
#      Calls `install-bundle.sh` to fetch the pinned bundle tarball
#      from a GitHub Release. Guaranteed reproducible — the version is
#      pinned in package.json#snapcap.bundle.
#
# In both modes, also:
#   - Runs `bun install --frozen-lockfile` for node_modules (fast — bun
#     pulls from its global cache).
#   - Copies .snapcap-smoke.json from $SNAPCAP_PARENT_REPO if available
#     (set the env var to point at the main repo, e.g.
#     SNAPCAP_PARENT_REPO=/home/me/snapcap/SnapSDK). Needed for live
#     integration tests that call real Snap APIs.
#   - Copies .tmp/auth/*.json from $SNAPCAP_PARENT_REPO if available.
#     Optional — without them, live tests do cold-login (slow + risks
#     soft-blocks).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VENDOR_PATH="${1:-}"

echo "[worktree-init] repo: $REPO_ROOT"

# 1. node_modules — bun handles this fast via its global cache.
if [ ! -d "node_modules" ]; then
  echo "[worktree-init] installing node_modules..."
  bun install --frozen-lockfile
else
  echo "[worktree-init] node_modules already present"
fi

# 2. vendor/snap-bundle — symlink from arg, or download pinned.
if [ -d "vendor/snap-bundle" ] || [ -L "vendor/snap-bundle" ]; then
  echo "[worktree-init] vendor/snap-bundle already present"
elif [ -n "$VENDOR_PATH" ]; then
  # Symlink mode.
  if [ ! -d "$VENDOR_PATH/snap-bundle" ]; then
    echo "[worktree-init] FATAL: $VENDOR_PATH/snap-bundle does not exist."
    echo "  Provide a path whose snap-bundle/ subdir is populated, OR omit"
    echo "  the arg to download the pinned tarball from GitHub instead."
    exit 1
  fi
  mkdir -p vendor
  ln -s "$VENDOR_PATH/snap-bundle" vendor/snap-bundle
  echo "[worktree-init] symlinked vendor/snap-bundle → $VENDOR_PATH/snap-bundle"
else
  # Download mode.
  echo "[worktree-init] no VENDOR_PATH given — downloading pinned bundle..."
  bash scripts/install-bundle.sh
fi

# 3. .snapcap-smoke.json — only copy if env var points us at a parent repo
#    that has it. Otherwise the live tests just won't have credentials,
#    which is fine (developer can copy manually if needed).
if [ ! -f ".snapcap-smoke.json" ] && [ -n "${SNAPCAP_PARENT_REPO:-}" ]; then
  if [ -f "$SNAPCAP_PARENT_REPO/.snapcap-smoke.json" ]; then
    cp "$SNAPCAP_PARENT_REPO/.snapcap-smoke.json" .
    echo "[worktree-init] copied .snapcap-smoke.json from parent"
  fi
fi

# 4. .tmp/auth/ — same idea. Skip silently if no parent given.
if [ -n "${SNAPCAP_PARENT_REPO:-}" ] && [ -d "$SNAPCAP_PARENT_REPO/.tmp/auth" ]; then
  mkdir -p .tmp/auth
  # Use cp -n to never overwrite if the worktree already has its own.
  cp -n "$SNAPCAP_PARENT_REPO/.tmp/auth/"*.json .tmp/auth/ 2>/dev/null || true
  echo "[worktree-init] copied auth files from parent"
fi

echo "[worktree-init] ✓ ready."
echo "  - node_modules:        $([ -d node_modules ] && echo yes || echo no)"
echo "  - vendor/snap-bundle:  $([ -e vendor/snap-bundle ] && echo yes || echo no)"
echo "  - .snapcap-smoke.json: $([ -f .snapcap-smoke.json ] && echo yes || echo no)"
echo "  - .tmp/auth/:          $([ -d .tmp/auth ] && echo yes || echo no)"
