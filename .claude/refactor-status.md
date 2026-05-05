# SnapSDK feature-folder refactor — status

**Branch:** `refactor/feature-folders` (off `main`).
**Started:** 2026-05-04.
**Goal:** convert SnapSDK's monolith files into feature directories per the user's preference. Many small focused files (~30–250 LOC each) with `index.ts` barrel re-exports keep the consumer-facing import surface stable while making the codebase navigable + agent-friendly (smaller files = faster grep + skip).

This file is the canonical phase tracker. Update it as phases land.

## Phase status

### ✅ Phase 1 (pilot) — `api/auth.ts` → `api/auth/`
- 807 LOC → 14 files, max 161 LOC
- `index.ts` re-exports the public surface (`authenticate`, `logout`, `refreshAuthToken`, `getAuthToken`, etc.)
- Validated the trampoline-method pattern + barrel approach
- Commit: `3407b30`

### ✅ Phase 2A (parallel) — `api/friends.ts` + `api/messaging.ts`
- `api/friends.ts` (1482 LOC) + `api/_friend_graph_cache.ts` (196 LOC) → `api/friends/` (16 files, max 248)
- `api/messaging.ts` (1485 LOC) → `api/messaging/` (18 files including `parse/` subdir, max 305)
- Both used internal-accessor object pattern (Cell + Slot wrappers) for cross-file mutable-field access
- Friends interface split into 3 sub-interfaces (mutations / reads / subscriptions)
- Commits: `27d83cb`, `7265a2d`, merges `dc8cdab`, `218ee81`

### ✅ Bundle infrastructure (parallel-track)
- Pinned Snap bundle via **GitHub Releases**: `bundle-2026-05-05` tagged + `package.json#snapcap.bundle` pin
- `scripts/install-bundle.sh` — fetches pinned tarball + sha-verify
- `scripts/release-bundle.sh` — packages current vendor + creates new release + bumps pin
- `scripts/refresh-bundle.sh` — pulls fresh from Snap CDN (rare; only when SDK breaks)
- `scripts/worktree-init.sh` — bootstraps a fresh worktree (auto-detects sibling vendor, copies smoke, symlinks `.tmp/`). REPO_ROOT via `git rev-parse --show-toplevel` (robust to absolute-path invocation)
- 32 personal probe/test scripts moved to `.tmp/scripts/` (gitignored — contained hardcoded usernames + conv UUIDs)
- Commits: `b30a206`, `eda2bc1`, `fff73aa`, `f385e9a`, `be5f212`

### ✅ Phase 2B.1 — `bundle/types.ts` → `bundle/types/`
- 915 LOC → 12 files, max 205 LOC
- One file per Snap-bundle domain: shared, snap, friends, messaging, conversations, media, rpc, chat-store, presence, login, search
- Acyclic type dependency graph
- Commits: `ae4c89d`, merge `75ea5b4`

### ✅ Phase 2B.2 — `bundle/register.ts` → `bundle/register/`
- 803 LOC → 15 files, max 125 LOC
- Helpers (`reach`, `reachModule`), constants (`patch-keys`, `module-ids`), per-domain getters
- `PresenceStateEnum` interface kept in `register/presence.ts` (bundle runtime structure tied 1:1 to its accessor, not pure type)
- Commits: `e5ef608`, merge `ff7d652`

### ✅ User-locker + per-user configs
- `tests/lib/user-locker.ts` (~250 LOC): `withLockedUser`, `checkoutUser`, `releaseUser`, `listConfiguredUsers`
- Atomic `mkdir(.tmp/locks/<user>.lock)` + PID-alive stale-lock cleanup
- Per-user configs at `.tmp/configs/<username>.config.json` (split from `.snapcap-smoke.json`, includes credentials + cached friend graph + fingerprint)
- Storage renamed: `.tmp/auth/` → `.tmp/storage/`
- `tests/api/messaging-myai.test.ts` migrated to use `checkoutUser`/`releaseUser` (still passes 1/1, ~14s)
- Commit: `64ef18f`

---

## ⏳ Phase 3 — rename `src/auth/` → `src/bundle/chat/standalone/` + split fidelius files

Two files in `src/auth/` are misnamed (don't do login auth — they're bundle realm management):
- `src/auth/fidelius-mint.ts` (493 LOC) — boots a SECOND chat WASM in an isolated vm.Context for the identity mint. WASM #1 in main sandbox has corrupted Embind state due to neutered Worker shim; WASM #2 is the clean realm.
- `src/auth/fidelius-decrypt.ts` (1698 LOC) — brings up the bundle's messaging session in the standalone realm. NOT decryption — the bundle's WASM does that. Should rename to something like `messaging-bringup.ts`.

Target structure (per investigation agent's proposal, confirmed with user):

```
src/bundle/chat/standalone/
  index.ts
  realm.ts              (was fidelius-mint.ts — getStandaloneChatRealm + getStandaloneChatModule)
  identity-mint.ts      (was fidelius-mint.ts — mintFideliusIdentity)
  types.ts              (KeyManagerStatics, StandaloneChatRealm, StandaloneChatModule)
  session/
    index.ts
    setup.ts            (setupBundleSession entry)
    realm-globals.ts    (CustomEvent/Event/EventTarget/Worker stubs)
    ws-shim.ts          (WebSocket shim — note: should also reuse src/shims/websocket.ts factory eventually)
    chunk-patch.ts      (f16f14e3 source-patch)
    wrap-session-create.ts
    push-handler.ts
    deliver-plaintext.ts
    id-coercion.ts
    types.ts            (PlaintextMessage, SetupBundleSessionOpts, etc.)
```

`src/auth/` directory disappears entirely.

**Big TODO** to include in `src/bundle/chat/standalone/index.ts` jsdoc: the WASM duplication (~12MB extra in memory + ~250ms boot time per `SnapcapClient`) is a known compromise. Root cause is the bundle expects a Web Worker hosting the WASM via Comlink, and our Worker shim is "neutered" to prevent metrics/sentry boot loops — which corrupts internal state for static Embind calls. Fixing properly = reverse-engineering Snap's worker init sequence (1-2 weeks investigation). Standalone realm sidesteps this at the cost of duplication. Worth fixing if multi-tenancy ever scales to N>20 per process.

### ✅ Phase 4 — Test foundation (Opus)

Built the test infrastructure that future Sonnet agents fan out tests against:

1. **Test audit** (`tests/AUDIT.md`) — every `src/` file categorized as PURE (27) / STATE-DRIVEN (22) / NETWORK (13) / LIVE-ONLY (14). Plus suggested Phase-5 priority order.
2. **Mock-Sandbox helper** (`tests/lib/mock-sandbox.ts`) — fluent builder; `mockSandbox().withGlobal(k,v).withChatStore(state).build()` returns a Sandbox-shaped duck-typed object. The `.withChatStore(state)` shortcut wires a fake `__snapcap_chat_p` webpack require so `chatStore(sandbox).getState()` resolves an in-memory Zustand-like store. Test-side handle accessible via `sandbox._chatStore` for subscription tests.
3. **Bundle-state fixtures** (`tests/lib/fixtures/`) — `auth-slice.ts` (default / signed-out / mid-refresh), `user-slice.ts` (default / smallGraph / largeGraph / enveloped), `presence-slice.ts` (default / active / away), `messaging-slice.ts` (default / oneConv / manyConv), plus `chatStateFixture()` composer.
4. **Reference tests**:
   - PURE: `tests/api/friends/mappers.test.ts` (14 tests, ~24ms)
   - STATE-DRIVEN: `tests/api/friends/snapshot.test.ts` (8 tests, ~76ms)
   - INTEGRATION: `tests/api/friends-snapshot.live.test.ts` (1 test, ~8s warm)
5. **Patterns playbook** (`tests/PATTERNS.md`) — decision tree, per-pattern templates, mock-Sandbox API + 3 examples, fixture extension guide, anti-spam rules for live tests, file-organization conventions.

Verification gates all pass: lint clean (only pre-existing `logging.ts:111`), typecheck unchanged (3 pre-existing src errors + pre-existing test-file errors), all reference tests pass, existing isolation + myai tests still pass.

### Phase 5 dispatch template

Boilerplate prompt for fan-out agents — substitute the bracketed slots:

```
You're Phase 5[ID] — write tests for [DOMAIN].

Step 1: bash scripts/worktree-init.sh
Step 2: git rebase refactor/feature-folders

Pre-read (in order):
1. tests/AUDIT.md — find your domain's bucket assignments
2. tests/PATTERNS.md — the playbook
3. The src/ files in [DOMAIN] you're testing
4. tests/api/friends/mappers.test.ts (PURE reference)
5. tests/api/friends/snapshot.test.ts (STATE-DRIVEN reference)
6. tests/api/friends-snapshot.live.test.ts (INTEGRATION reference)

Deliverables:
- One `tests/<DOMAIN>/<file>.test.ts` per src file in your bucket assignments.
- Use `mockSandbox()` + `chatStateFixture()` for STATE-DRIVEN.
- Use `withLockedUser` for INTEGRATION (rare; one per domain typically).
- Each test file < 300 LOC; split if larger.
- Use existing fixtures; only add new ones if a needed slice shape is missing.

Verification (mandatory before reporting done):
- bash scripts/lint-no-singletons.sh — only pre-existing `logging.ts:111` allowed
- bun run typecheck — only pre-existing errors allowed
- bun test tests/<your test files> — all pass
- bun test tests/shims/multi-instance-isolation.test.ts — still passes
- bun test tests/api/messaging-myai.test.ts — still passes

Constraints:
- Touch ONLY tests/ (no src/ changes)
- DO NOT commit, push, or merge
- Report back: branch path, test-count + LOC delta, verification gate results.
```

### ⏳ Phase 5 — Test fan-out (Sonnet, parallel)

Per-domain test agents, each in own worktree, each owns one slice:

| Agent | Domain | Likely test files |
|---|---|---|
| 5A | Friends | `tests/api/friends/{mappers,snapshot-builders,graph-cache,subscriptions,mutations,reads}.test.ts` |
| 5B | Messaging | `tests/api/messaging/{parse-*,send,presence,bringup}.test.ts` |
| 5C | Auth | `tests/api/auth/{authenticate,sso-ticket,refresh,kickoff-messaging}.test.ts` |
| 5D | Bundle | `tests/bundle/{register,types,presence-bridge,prime}.test.ts` |
| 5E | Storage / Shims | `tests/storage/*.test.ts`, `tests/shims/*.test.ts` |

### ⏳ Phase 6 — Bloat audit via knip

```bash
bun add -D knip
```

Configure entry points (src/index.ts, scripts/, tests/), run, get list of unused files / exports / deps. User reviews per-item; nothing auto-deletes.

---

## Critical lessons (apply to every future agent prompt)

1. **Model choice:** Sonnet for mechanical splits/refactors. Opus for design judgment (test foundation, novel architecture, deep diagnostics).

2. **Worktree base quirk:** Claude's Agent tool creates worktrees from `main`, NOT the current branch. Every agent prompt MUST include:
   ```
   Step 1: bash scripts/worktree-init.sh
   Step 2: git rebase refactor/feature-folders
   ```
   Without Step 2, the agent edits pre-split monolith files and the merge requires manual reconciliation.

3. **Verify dynamic imports** during refactor: a static `from "..."` grep misses `await import("...")`. Always run `bun run typecheck` after path updates.

4. **`worktree-init.sh` cascade order**: explicit arg → sibling worktree (auto-detect) → download from pinned GH Release. Same cascade for vendor, smoke, .tmp. Symlinked, not copied (except smoke.json which is small + read-only).

5. **User-locker for any account-touching test**: `withLockedUser(async (user) => { ... })`. Prevents JWT-refresh race that invalidates sessions when N processes share an account.

6. **Personal scripts go in `.tmp/scripts/`** (gitignored), not `scripts/`. The `scripts/` directory is for project infrastructure only (install-bundle, release-bundle, lint, hooks, worktree-init, update-docs).

7. **Lint in `scripts/lint-no-singletons.sh`** must pass after every file change. Only allowlisted finding is the pre-existing `logging.ts:111` (`activeLogger`).

8. **Verification suite (4 gates)** for every refactor:
   - `bash scripts/lint-no-singletons.sh`
   - `bun run typecheck` (only pre-existing 3 errors acceptable)
   - `bun test tests/shims/multi-instance-isolation.test.ts`
   - `bun test tests/api/messaging-myai.test.ts` (live decrypt — strongest signal)

9. **Don't touch existing `src/` code in test-only commits.** Test infrastructure goes in `tests/lib/`. SDK `src/lib/` is for SDK runtime utilities (e.g. `typed-event-bus.ts`).

---

## Repo state checkpoints

| Commit | What |
|---|---|
| `3407b30` | Phase 1 pilot — auth split |
| `27d83cb`, `7265a2d` | Phase 2A — friends + messaging splits (in worktree branches) |
| `dc8cdab`, `218ee81` | Phase 2A merges into refactor |
| `a0acd62` | Phase 2A fixup — auth dynamic-import paths |
| `b801603` | Earlier — full presence layer (pre-refactor; on main) |
| `b30a206` | Bundle pinning + worktree-init script |
| `eda2bc1` | worktree-init auto-detect sibling vendor |
| `fff73aa` | worktree-init symlinks `.tmp/` wholesale |
| `f385e9a` | Personal scripts → `.tmp/scripts/` |
| `be5f212` | worktree-init fix: REPO_ROOT via git rev-parse |
| `ae4c89d`, `75ea5b4` | Phase 2B.1 — types split + merge |
| `e5ef608`, `ff7d652` | Phase 2B.2 — register split + merge |
| `64ef18f` | User-locker + per-user configs + storage rename |

`origin/main` is currently at `7d39e52` (pre-refactor; we haven't pushed `refactor/feature-folders` yet).
