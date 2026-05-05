# SnapSDK Bloat Audit — Phase 6

Knip run: 2026-05-05. Branch: `worktree-agent-ac4bf661dd10e52ad` (off `refactor/feature-folders`).
Knip config: `knip.json` v6, entry = `src/index.ts` + all test files + all shell scripts + both git hooks.

```
- Total unused files:         0
- Total unused exports:       8  (functions)
- Total unused exported types: 1
- Total unused dependencies:  1  (sharp — production dep)
- Total unused devDependencies: 0
```

> Configuration hints from knip (not bugs — safe to address later):
> - `scripts/*.ts` project pattern matches no files (scripts are all `.sh`).
> - `src/index.ts` listed as entry is redundant (knip infers it from `project`).
> - Several `ignore` patterns (vendor, dist, docs, .tmp, .claude, node_modules) match nothing from knip's project graph — safe to keep for clarity; removing them would cause knip to scan those trees.
> - Several `ignoreDependencies` entries (typedoc plugins, `@types/bun`) appear used — knip may not resolve TypeDoc plugin wiring via `typedoc.json`; keep the ignores.

---

## Top-5 Surprises

1. **`sharp` in production deps but never imported** (`package.json:66`). The dependency was used by the old `postStory` image normalization path, which has since been moved or refactored. Zero imports in `src/`, `tests/`, or `scripts/`. This is real dead weight (~30 MB on install).

2. **`makeConversationRef` exported but has zero callers** (`src/api/_helpers.ts:127`). Marked `@internal`, yet exported. Every conversation-ref construction site in the codebase appears to have been rewritten inline (see `src/api/_media_upload.ts:189` which duplicates the logic). This function was almost certainly the canonical version before the messaging split and was never cleaned up.

3. **`bootKameleon` exported but only `getKameleon` is called** (`src/bundle/accounts-loader.ts:96`). `bootKameleon` is a thin wrapper (`return ctx` from `getKameleon`) exported `@internal`. No caller exists in `src/`, `tests/`, or `scripts/`. The internal path uses `getKameleon` directly. Either the wrapper was forgotten after Phase 2 or it is a future-facing API that was never wired up.

4. **`getStandaloneChatModule` exported alongside `getStandaloneChatRealm` but only the latter is called** (`src/bundle/chat/standalone/realm.ts:61`). The codebase consistently calls `getStandaloneChatRealm` (returns the full realm payload). `getStandaloneChatModule` returns only the `moduleEnv` sub-object. It is re-exported from `standalone/index.ts` and from there is reachable via `src/index.ts` (`export type { PlaintextMessage } from "./bundle/chat/standalone/index.ts"` re-exports from the same barrel). However, the function itself has no callers — either it was a temporary stepping-stone during Phase 3 that `getStandaloneChatRealm` superseded, or it was meant as a lighter public API for consumers who only need the module env.

5. **Three test fixture functions exported with zero test consumers** (`signedOutAuthFixture`, `oneConvMessagingSliceFixture`, `largeGraphUserSliceFixture`). These were written during Phase 4 as part of the fixture library. The test agents (Phase 5) each picked the fixtures they needed — these three were designed but never called by any test. They are low-risk test infrastructure, but they signal that the fixture library grew beyond what the test fan-out actually required.

---

## Likely Safe to Delete

> These have no callers in `src/`, `tests/`, or `scripts/`. Removal carries low risk.

### ~~`sharp` — production dependency (`package.json:66`)~~ ✅ removed

- **Knip:** unused dependency.
- **Verification:** `grep -r "sharp" src/ tests/ scripts/` → zero results. Not imported anywhere.
- **Resolution:** `src/api/stories.ts:68` documents that auto-normalization to 1080×1920 RGBA PNG is the bundle's responsibility once it sniffs the Blob — the SDK passes raw bytes through. `sharp` was a leftover from an abandoned SDK-side normalization path. Removed from `dependencies`. Test suite unchanged (562 pass / 14 pre-existing fails).

### ~~`makeConversationRef` — `src/api/_helpers.ts:127`~~ ✅ removed

- **Knip:** unused export (function).
- **Verification:** `rg -rn "makeConversationRef" src/ tests/ scripts/` → only the definition line. Not called anywhere.
- **Note:** Marked `@internal` in JSDoc. `_media_upload.ts` duplicates its logic inline rather than calling it. This is a candidate for deletion, OR for replacing the inline duplicate in `_media_upload.ts` with a call to this function (the cleaner fix). Either way, the exported symbol is currently dead.

### ~~`listConfiguredUsers` — `tests/lib/user-locker.ts:158`~~ ✅ removed

- **Knip:** unused export (function).
- **Verification:** `rg -rn "listConfiguredUsers" tests/ src/ scripts/` → only the definition line.
- **Assessment:** This is test-lib infrastructure that was never consumed by any test. It lists per-user config files from `.tmp/configs/`. Could be useful for a future "list available accounts" script, but currently dead. Safe to remove from the exports (or make it unexported) if no such script is planned.

---

## Investigate First

> These have ambiguous usage signals — exported, referenced in documentation or secondary contexts, or exported as public API that may be intentionally forward-looking.

### `bootKameleon` — `src/bundle/accounts-loader.ts:96`

- **Knip:** unused export (function).
- **Verification:** `rg -rn "bootKameleon" src/ tests/ scripts/` → only definition + two JSDoc references in the same file.
- **Ambiguity:** The function is `@internal` (not part of public `src/index.ts`). Its sibling `getKameleon` is what callers actually use. `bootKameleon` is a thin convenience wrapper that strips the `BootedKameleon` wrapper and returns just the `KameleonContext`. It may have been retained as a cleaner API seam for future direct callers (e.g. `scripts/mint-attestation.ts` might want it). Recommend checking whether any forthcoming scripting surface needs the lighter `bootKameleon` vs `getKameleon` API before removing.

### ~~`getStandaloneChatModule` — `src/bundle/chat/standalone/realm.ts:61`~~ ✅ removed

- **Knip:** unused export (function).
- **Verification:** `grep -rn "getStandaloneChatModule" src/ tests/` → only definition + re-export in `standalone/index.ts`. No callers.
- **Ambiguity:** Re-exported from `standalone/index.ts`, which is referenced (but only for `PlaintextMessage` type) from `src/index.ts`. The function is therefore technically reachable via the public barrel but never called — not by internal code and not by any test. It appears to be a stepping-stone API from Phase 3 that `getStandaloneChatRealm` replaced. However, removing it would narrow the public standalone surface, which may be intentional (consumers who need raw module env do exist in theory). Recommend confirming whether the standalone index is meant to expose `getStandaloneChatModule` as a consumer API.

### `Rpc` type — `src/api/fidelius.ts:61`

- **Knip:** unused exported type.
- **Verification:** `rg -n "Rpc" src/api/fidelius.ts` → only definition. No other file imports it.
- **Ambiguity:** JSDoc says "kept as a typed export for consumers who want to supply their own transport." This is forward-looking public API documentation, not an accident. If the intent is to allow future consumers to pass their own `Rpc` transport, the export is intentional. If Fidelius is not meant to be consumer-extendable, it's dead. Confirm the API surface intent.

### `withLockedUser` — `tests/lib/user-locker.ts:141`

- **Knip:** unused export (function).
- **Verification:** `rg -rn "import.*withLockedUser" tests/` → zero import statements (only JSDoc + comment references). The live test `friends-snapshot.live.test.ts` references it in a doc comment but imports `checkoutUser`/`releaseUser` directly instead.
- **Ambiguity:** The function is the idiomatic "try/finally" wrapper (see `tests/PATTERNS.md` decision tree: "acquire a real Snap account via `withLockedUser`"). It was designed as the recommended pattern for INTEGRATION tests, but all actual integration tests (including `messaging-myai.test.ts` and `friends-snapshot.live.test.ts`) use the lower-level `checkoutUser`/`releaseUser` pair instead. This is a mild design drift: the high-level API exists but no test uses it. Either adopt it consistently or drop it.

### `signedOutAuthFixture` — `tests/lib/fixtures/auth-slice.ts:60`

- **Knip:** unused export (function).
- **Verification:** `rg -rn "signedOutAuthFixture" tests/` → only definition.
- **Ambiguity:** The auth fixture library has three states (default / signed-out / mid-refresh). The `signedOutAuthFixture` was written to support tests that exercise the "no cached session" cold path. Phase 5C auth tests apparently didn't need it or used a different approach. Low risk to remove; worth checking if any planned auth tests would benefit from it first.

### `oneConvMessagingSliceFixture` — `tests/lib/fixtures/messaging-slice.ts:52`

- **Knip:** unused export (function).
- **Verification:** `rg -rn "oneConvMessagingSliceFixture" tests/` → only definition.
- **Ambiguity:** Phase 5B messaging tests exist and presumably used `defaultMessagingSliceFixture` instead of the one-conversation variant. If messaging tests need to add coverage for single-conversation scenarios, this fixture becomes useful. Currently dead.

### `largeGraphUserSliceFixture` — `tests/lib/fixtures/user-slice.ts:110`

- **Knip:** unused export (function).
- **Verification:** `rg -rn "largeGraphUserSliceFixture" tests/` → only definition.
- **Ambiguity:** The user fixture library has four states (default / smallGraph / largeGraph / enveloped). The `largeGraphUserSliceFixture` targets performance/scale scenarios. Phase 5A friends tests apparently didn't exercise the large-graph path. Potentially useful for future scale tests.

---

## Keep — False Positive

> Knip flagged these, but they are correctly used or are intentional API surface.

None identified. All knip findings in this run appear to be genuine (either unused, or at worst ambiguous intent). The `ignoreExportsUsedInFile: true` config correctly suppresses the many within-file helpers, so knip's output is clean.

---

## Verification Gates

- `bash scripts/lint-no-singletons.sh` — PASS (only pre-existing `logging.ts:111`)
- `bun run typecheck` — PASS (exactly 22 pre-existing errors: 3 src + 19 tests)
