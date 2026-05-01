#!/usr/bin/env bash
# Install repo-tracked git hooks into .git/hooks/.
#
# Git hooks live in .git/hooks/ which is NOT tracked by git. This script
# symlinks the tracked versions in scripts/git-hooks/ into the right place
# so a fresh clone gets the hooks with `bun run install-hooks`.
#
# Idempotent — safe to run multiple times.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DST" ]; then
  echo "[install-hooks] $HOOKS_DST does not exist — is this actually a git repo?"
  exit 1
fi

count=0
for src in "$HOOKS_SRC"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="$HOOKS_DST/$name"

  # Replace existing hook (or symlink) with our tracked version.
  rm -f "$dst"
  ln -s "$src" "$dst"
  chmod +x "$src"
  echo "[install-hooks] linked $name → $src"
  count=$((count + 1))
done

echo "[install-hooks] ✓ $count hook(s) installed."
