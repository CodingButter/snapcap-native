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

# 2. vendor/snap-bundle — three-tier cascade:
#      a. explicit VENDOR_PATH arg → symlink (highest priority)
#      b. sibling worktree has vendor/snap-bundle → symlink (auto-detect)
#      c. download pinned tarball from GitHub Release (fallback)
if [ -d "vendor/snap-bundle" ] || [ -L "vendor/snap-bundle" ]; then
  echo "[worktree-init] vendor/snap-bundle already present"
elif [ -n "$VENDOR_PATH" ]; then
  # Tier (a): explicit arg.
  if [ ! -d "$VENDOR_PATH/snap-bundle" ]; then
    echo "[worktree-init] FATAL: $VENDOR_PATH/snap-bundle does not exist."
    echo "  Provide a path whose snap-bundle/ subdir is populated, OR omit"
    echo "  the arg to let the script auto-detect or download."
    exit 1
  fi
  mkdir -p vendor
  ln -s "$VENDOR_PATH/snap-bundle" vendor/snap-bundle
  echo "[worktree-init] symlinked vendor/snap-bundle → $VENDOR_PATH/snap-bundle (explicit)"
else
  # Tier (b): walk attached worktrees, find first one with a populated
  # vendor/snap-bundle/. `git worktree list --porcelain` outputs blocks
  # of `worktree <path>` lines; we only consider paths that aren't us.
  SELF="$REPO_ROOT"
  SIBLING_VENDOR=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        candidate="${line#worktree }"
        if [ "$candidate" != "$SELF" ] && [ -d "$candidate/vendor/snap-bundle" ]; then
          SIBLING_VENDOR="$candidate/vendor/snap-bundle"
          break
        fi
        ;;
    esac
  done < <(git worktree list --porcelain)

  if [ -n "$SIBLING_VENDOR" ]; then
    mkdir -p vendor
    ln -s "$SIBLING_VENDOR" vendor/snap-bundle
    echo "[worktree-init] symlinked vendor/snap-bundle → $SIBLING_VENDOR (auto-detected sibling)"
  else
    # Tier (c): download pinned.
    echo "[worktree-init] no sibling worktree has vendor — downloading pinned bundle..."
    bash scripts/install-bundle.sh
  fi
fi

# 3. .snapcap-smoke.json — same cascade as vendor:
#      a. explicit SNAPCAP_PARENT_REPO env var
#      b. auto-detect via `git worktree list`
#      c. skip silently (live tests will be skipped — fine for fresh clones)
if [ ! -f ".snapcap-smoke.json" ]; then
  if [ -n "${SNAPCAP_PARENT_REPO:-}" ] && [ -f "$SNAPCAP_PARENT_REPO/.snapcap-smoke.json" ]; then
    cp "$SNAPCAP_PARENT_REPO/.snapcap-smoke.json" .
    echo "[worktree-init] copied .snapcap-smoke.json from $SNAPCAP_PARENT_REPO (explicit)"
  else
    while IFS= read -r line; do
      case "$line" in
        worktree\ *)
          candidate="${line#worktree }"
          if [ "$candidate" != "$SELF" ] && [ -f "$candidate/.snapcap-smoke.json" ]; then
            cp "$candidate/.snapcap-smoke.json" .
            echo "[worktree-init] copied .snapcap-smoke.json from $candidate (auto-detected sibling)"
            break
          fi
          ;;
      esac
    done < <(git worktree list --porcelain)
  fi
fi

# 4. .tmp/auth/ — same cascade. Auth files are COPIED (not symlinked) so
#    each worktree has its own — prevents JWT-refresh races across
#    parallel workers using the same account. WARNING: parallel agents
#    using the same account WILL still hit Snap-side session invalidation
#    on bearer refresh. For parallel work, use distinct accounts via
#    tests/lib/user-locker (when added) or explicit per-agent credentials.
if [ ! -d ".tmp/auth" ] || [ -z "$(ls -A .tmp/auth 2>/dev/null)" ]; then
  AUTH_SRC=""
  if [ -n "${SNAPCAP_PARENT_REPO:-}" ] && [ -d "$SNAPCAP_PARENT_REPO/.tmp/auth" ]; then
    AUTH_SRC="$SNAPCAP_PARENT_REPO/.tmp/auth"
    AUTH_FROM="$SNAPCAP_PARENT_REPO (explicit)"
  else
    while IFS= read -r line; do
      case "$line" in
        worktree\ *)
          candidate="${line#worktree }"
          if [ "$candidate" != "$SELF" ] && [ -d "$candidate/.tmp/auth" ] && [ -n "$(ls -A "$candidate/.tmp/auth" 2>/dev/null)" ]; then
            AUTH_SRC="$candidate/.tmp/auth"
            AUTH_FROM="$candidate (auto-detected sibling)"
            break
          fi
          ;;
      esac
    done < <(git worktree list --porcelain)
  fi
  if [ -n "$AUTH_SRC" ]; then
    mkdir -p .tmp/auth
    cp -n "$AUTH_SRC/"*.json .tmp/auth/ 2>/dev/null || true
    echo "[worktree-init] copied auth files from $AUTH_FROM"
  fi
fi

echo "[worktree-init] ✓ ready."
echo "  - node_modules:        $([ -d node_modules ] && echo yes || echo no)"
echo "  - vendor/snap-bundle:  $([ -e vendor/snap-bundle ] && echo yes || echo no)"
echo "  - .snapcap-smoke.json: $([ -f .snapcap-smoke.json ] && echo yes || echo no)"
echo "  - .tmp/auth/:          $([ -d .tmp/auth ] && echo yes || echo no)"
