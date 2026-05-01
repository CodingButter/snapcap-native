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
echo "[docs] Running Claude doc-update agent..."
claude -p "$(cat "$PROMPT_FILE")" \
  --dangerously-skip-permissions \
  --max-turns 30

# 3. Commit if anything changed under docs/.
if git diff --quiet docs/ && git diff --cached --quiet docs/; then
  echo "[docs] No doc changes."
  exit 0
fi

echo "[docs] Doc changes detected — committing."
git add docs/
git commit -m "docs: auto-update via claude $(date +%Y-%m-%d)"
echo "[docs] ✓ Doc commit added. Will be included in the push."
