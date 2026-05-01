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
#    Don't `set -e` bail on a non-zero exit — claude may have hit max-turns
#    after making partial progress. We still want to capture whatever it
#    wrote in the commit step below.
echo "[docs] Running Claude doc-update agent..."
set +e
claude -p "$(cat "$PROMPT_FILE")" \
  --dangerously-skip-permissions \
  --max-turns 60
claude_exit=$?
set -e
if [ $claude_exit -ne 0 ]; then
  echo "[docs] ⚠ Claude exited with code $claude_exit (likely hit --max-turns)."
  echo "[docs]   Will still commit any partial work. Re-run if more updates needed."
fi

# 3. Commit if anything changed under docs/, src/, or .claude/.
#    - docs/   — the hand-written guides claude updates
#    - src/    — TSDoc comments claude legitimately edits when an
#                improvement materially helps consumers
#    - .claude/ — claude's self-improvement updates to its own directive
#                 (the "Lessons learned" section in doc_guide_description.md).
#                 If we don't capture these, the wisdom doesn't compound
#                 across runs.
if git diff --quiet docs/ src/ .claude/ && git diff --cached --quiet docs/ src/ .claude/; then
  echo "[docs] No doc changes."
  exit 0
fi

echo "[docs] Doc changes detected — committing."
git add docs/ src/ .claude/
git commit -m "docs: auto-update via claude $(date +%Y-%m-%d)"
echo "[docs] ✓ Doc commit added. Will be included in the push."
