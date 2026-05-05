#!/usr/bin/env bash
# Regenerate auto API reference + run Claude to update hand-written docs.
# Invoked by:
#   - `bun run docs:update` (manual)
#   - `.git/hooks/pre-push` (auto on push, after install-hooks.sh)
#
# Skipped via:
#   - `git push --no-verify` (standard git escape hatch — bypasses the hook entirely)
#   - `SNAPCAP_SKIP_DOC_UPDATE=1 git push` (env var, more explicit)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ "${SNAPCAP_SKIP_DOC_UPDATE:-0}" = "1" ]; then
  echo "[docs] SNAPCAP_SKIP_DOC_UPDATE=1 — skipping doc update."
  exit 0
fi

PROMPT_FILE=".claude/doc_guide_description.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "[docs] missing $PROMPT_FILE — cannot run doc agent. Bailing."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "[docs] 'claude' CLI not found in PATH. Install Claude Code or run with"
  echo "       SNAPCAP_SKIP_DOC_UPDATE=1 to bypass."
  exit 1
fi

# 1. Regenerate auto API reference (TypeDoc → MDX into docs/content/docs/api/).
echo "[docs] Regenerating API reference..."
bun run docs:api

# 2. Run Claude headless to review diff + update hand-written guides.
#    `--max-turns 65` gives a small buffer so the directive's
#    "wrap up + write self-improvement at turn 60" rule has runway to
#    actually execute. `set +e` so partial work commits even when claude
#    exits non-zero.
echo "[docs] Running Claude doc-update agent (max 65 turns)..."
set +e
claude -p "$(cat "$PROMPT_FILE")" \
  --dangerously-skip-permissions \
  --max-turns 65
claude_exit=$?
set -e
if [ $claude_exit -ne 0 ]; then
  echo "[docs] ⚠ Claude exited with code $claude_exit (likely hit --max-turns)."
  echo "[docs]   Will still commit any partial work. Re-run if more updates needed."
fi

# 3. Commit if anything changed under docs/, src/, or .claude/.
#    - docs/   — hand-written guides claude updates
#    - src/    — TSDoc improvements claude legitimately makes
#    - .claude/ — claude's self-improvement updates to the directive
if git diff --quiet docs/ src/ .claude/ && git diff --cached --quiet docs/ src/ .claude/; then
  echo "[docs] No doc changes."
  exit 0
fi

echo "[docs] Doc changes detected."
git add docs/ src/ .claude/

# Amend doc changes into the most-recent commit so the push transmits
# ONE atomic commit (feature + its docs together) instead of a separate
# follow-up doc commit that races the push range. Safety check: only
# amend if HEAD has not yet been published to origin/main — otherwise
# we'd be rewriting shared history.
HEAD_SHA="$(git rev-parse HEAD)"
UPSTREAM_SHA="$(git rev-parse @{u} 2>/dev/null || true)"

if git merge-base --is-ancestor "$HEAD_SHA" "$UPSTREAM_SHA" 2>/dev/null; then
  # HEAD is already on the remote — amending would rewrite published
  # history. Fall back to a separate commit (the legacy behavior).
  echo "[docs] HEAD is already published — falling back to a separate doc commit."
  git commit -m "docs: auto-update via claude $(date +%Y-%m-%d)"
  echo "[docs] ✓ Doc commit added. Will be included in the push."
else
  # Amend onto the unpushed commit so the push gets one atomic change.
  echo "[docs] Amending doc changes into HEAD ($HEAD_SHA — unpushed)."
  git commit --amend --no-edit
  echo "[docs] ✓ Doc changes amended into HEAD. Push will transmit one commit."
fi
