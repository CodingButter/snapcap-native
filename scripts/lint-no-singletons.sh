#!/usr/bin/env bash
# lint-no-singletons.sh — enforce per-instance isolation in src/.
#
# Per-instance isolation is the SDK's whole multi-tenant story: two
# SnapcapClient instances in one process must share NOTHING. Module-scope
# mutable state (`let X = ...` at column 0, mutable Maps at module scope,
# etc.) silently breaks this and is invisible in single-client tests.
#
# This script grep-fails when it finds the anti-patterns. To allowlist a
# specific line that's genuinely per-instance-safe, append:
#   // MULTI-INSTANCE-SAFE: <one-sentence reason>
#
# See:
#   - SnapSDK/CLAUDE.md "Critical invariants" section
#   - memory/feedback_no_module_scope_state.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Patterns that flag module-scope mutable state.
PATTERN='^(let |var |const [A-Za-z_][A-Za-z0-9_]* *= *new (Map|Set|WeakMap|WeakSet)\b)'

# Raw findings.
raw=$(grep -rnE "$PATTERN" src/ --include='*.ts' || true)

# Filter benign cases:
#   - lines marked safe via comment (MULTI-INSTANCE-SAFE)
#   - stateless utility constructors (TextEncoder, TextDecoder)
#   - readonly type-tagged constants (ReadonlySet, ReadonlyMap)
filtered=$(echo "$raw" \
  | grep -v 'MULTI-INSTANCE-SAFE' \
  | grep -vE 'new (TextEncoder|TextDecoder)\(\)' \
  | grep -vE ': ?Readonly(Set|Map)' \
  || true)

# Empty result → pass.
if [ -z "$filtered" ]; then
  echo "[lint:no-singletons] OK — no module-scope mutable state in src/"
  exit 0
fi

cat <<EOF
[lint:no-singletons] FAIL — module-scope mutable state detected:

$filtered

Per-instance isolation is non-negotiable. State must live on:
  - a private/# field of a per-instance class (Messaging, Sandbox, etc.)
  - the ClientContext bag (api/_context.ts)
  - a WeakMap<Sandbox, T> keyed by sandbox

See SnapSDK/CLAUDE.md "Critical invariants" section.

If a finding is genuinely per-instance-safe, allowlist with a trailing
comment on the same line:
  // MULTI-INSTANCE-SAFE: <one-sentence reason>
EOF

exit 1
