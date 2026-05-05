# Test patterns — fan-out playbook

This is the field manual for Phase-5 test fan-out. If you're a Sonnet agent
spawned to write tests for a domain, read this first, then follow the
matching pattern below.

## TL;DR decision tree

```
Q: Does the function under test touch I/O (fetch, WebSocket, fs)?
   ├── YES → does it ALSO need a real Snap account / bundle WASM?
   │         ├── YES → INTEGRATION (use withLockedUser; rare)
   │         └── NO  → NETWORK     (mock global fetch; common)
   │
   └── NO  → does it read bundle Zustand state via the registry
             (chatStore / userSlice / authSlice / presenceSlice / messagingSlice)?
             ├── YES → STATE-DRIVEN (use mockSandbox + slice fixtures)
             └── NO  → PURE         (no helpers — just import + assert)
```

If you're not sure, default to **PURE** — if it works, the function was
pure. If it throws "this property is undefined" while reaching for sandbox
state, you've discovered it's STATE-DRIVEN.

## File-organization conventions

```
tests/
├── AUDIT.md              ← every src file → bucket assignment
├── PATTERNS.md           ← this file
├── lib/
│   ├── user-locker.ts    ← live-test account checkout (DO NOT MODIFY)
│   ├── mock-sandbox.ts   ← MockSandbox builder
│   └── fixtures/
│       ├── index.ts          ← chatStateFixture barrel
│       ├── auth-slice.ts
│       ├── user-slice.ts
│       ├── presence-slice.ts
│       └── messaging-slice.ts
├── api/
│   ├── friends/
│   │   ├── mappers.test.ts            ← PURE
│   │   ├── snapshot.test.ts           ← STATE-DRIVEN
│   │   └── ...
│   ├── messaging/
│   │   ├── parse/
│   │   │   ├── envelope.test.ts        ← PURE
│   │   │   └── ...
│   │   └── ...
│   ├── auth/
│   │   └── ...
│   └── friends-snapshot.live.test.ts   ← INTEGRATION (suffix `.live`)
├── bundle/
│   ├── register/
│   │   └── ...
│   └── ...
├── shims/
│   ├── multi-instance-isolation.test.ts (existing)
│   └── ...
├── storage/
│   └── ...
└── transport/
    └── ...
```

Rules:

1. **Mirror `src/` exactly** — `src/api/friends/mappers.ts` →
   `tests/api/friends/mappers.test.ts`.
2. **One test file per src file** by default. Split per-domain when a
   single src file's tests exceed ~250 LOC.
3. **Live tests use `.live.test.ts` suffix** when reasonable, so a future
   "skip live in CI" filter is one glob change. Existing exceptions
   (`messaging-myai.test.ts`, `messaging-multi-account.test.ts`) keep
   their names.
4. **No re-exports from `tests/`** — every test file imports directly
   from `src/`. The `tests/lib/` exports live there because they're
   shared infra; nothing else.

---

## Pattern 1: PURE

### When

The function takes inputs, returns outputs. No DOM, no fetch, no Sandbox,
no bundle state. Examples: `friends/mappers.ts`, `transport/throttle.ts`,
`api/_helpers.ts:uuidToBytes`, `messaging/parse/proto-reader.ts`.

### Template

```ts
import { describe, expect, test } from "bun:test";
import { fnUnderTest } from "../../../src/path/to/file.ts";

describe("path/file — fnUnderTest", () => {
  test("does X for input Y", () => {
    expect(fnUnderTest(input)).toBe(expectedOutput);
  });

  test("handles edge case Z", () => {
    expect(fnUnderTest(edgeInput)).toEqual(expectedShape);
  });
});
```

### Reference

`tests/api/friends/mappers.test.ts` — 14 tests, 24ms runtime.

### Pitfalls

- **Don't import `mockSandbox` if you don't need it** — keeps the test
  file from accidentally turning into a STATE-DRIVEN test as it grows.
- **Don't reach for `MemoryDataStore` either** — pure tests don't need
  storage; that's a smell.

---

## Pattern 2: STATE-DRIVEN

### When

The function calls something like `userSlice(sandbox)`, `chatStore(sandbox)`,
`presenceSlice(sandbox).broadcastTypingActivity(...)`, etc. — anywhere
that goes through the bundle registry to read or drive Zustand state.

Examples: `friends/reads.ts`, `friends/snapshot-builders.ts` (when paired
with `userSlice`), `messaging/reads.ts:listConversations`,
`api/presence.ts`, every `bundle/register/*.ts` slice getter.

### Mock-Sandbox API

```ts
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  authSliceFixture,
  userSliceFixture,
  presenceSliceFixture,
  messagingSliceFixture,
  smallGraphUserSliceFixture,
} from "../../lib/fixtures/index.ts";

// Bare minimum — empty chat state
const sandbox1 = mockSandbox()
  .withChatStore(chatStateFixture())
  .build();

// With a populated friend graph
const sandbox2 = mockSandbox()
  .withChatStore(chatStateFixture({
    user: smallGraphUserSliceFixture(),
  }))
  .build();

// With a stubbed __SNAPCAP_* global (e.g. for register/auth.ts:loginClient)
const sandbox3 = mockSandbox()
  .withGlobal("__SNAPCAP_LOGIN_CTOR", FakeLoginClass)
  .build();
```

### Template

```ts
import { describe, expect, test } from "bun:test";
import { fnUnderTest } from "../../../src/path/to/file.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, /* slice fixtures */ } from "../../lib/fixtures/index.ts";

describe("path/file — fnUnderTest", () => {
  test("returns X when state is Y", async () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ /* slice overrides */ }))
      .build();

    const result = await fnUnderTest({ sandbox /* + other ctx fields */ });
    expect(result).toEqual(expectedShape);
  });
});
```

### Subscriptions / live state

For tests of `friends/subscriptions.ts` or anything that calls
`chatStore(sandbox).subscribe(...)`, drive deltas via the
`MockChatStore._emit(prev)` side-channel:

```ts
const sandbox = mockSandbox()
  .withChatStore(chatStateFixture({ user: userSliceFixture() }))
  .build();

const store = sandbox._chatStore!;     // grab the test-only handle
const emitted: any[] = [];
const sub = subscribeUserSlice(sandbox, (state, prev) => emitted.push(state));

const prev = store.getState();
store.setState({ user: smallGraphUserSliceFixture() });
expect(emitted).toHaveLength(1);
sub();
```

`setState` on the mock store automatically fires listeners with `(next, prev)`.

### Reference

`tests/api/friends/snapshot.test.ts` — 8 tests, 76ms runtime.

### Pitfalls

- **MockSandbox.runInContext throws** by design. If your code under test
  calls `sandbox.runInContext(src)`, either move that path into a separate
  function and unit-test the rest, or upgrade to a real `Sandbox`.
- **No DOM in MockSandbox.** `sandbox.window.document` returns an empty
  proxy. If your code needs `document.cookie` etc., construct a real
  `Sandbox` with a `MemoryDataStore`.
- **Don't pass slice fixture results around between tests.** Always call
  `userSliceFixture(...)` per test — even though it returns a fresh
  object, holding onto a reference invites accidental shared mutation
  via `setState({...})` updaters.

---

## Pattern 3: NETWORK

### When

The function calls `fetch`, opens a WebSocket, walks a cookie jar, or
otherwise hits the wire. Most often: `api/friends/mutations.ts`,
`api/friends/search.ts`, `api/auth/sso-ticket.ts`, `bundle/download.ts`,
`shims/fetch.ts`.

### Approach

The SDK's wire path goes through `transport/native-fetch.ts:loggingFetch`,
which reads from `globalThis.fetch` (Node's native). Tests can stub
`globalThis.fetch` per-test:

```ts
import { afterEach, beforeEach } from "bun:test";

let originalFetch: typeof globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(/* canned bytes */, { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});
```

For tests of files that take a `unary`-shaped fn (`friends/mutations.ts`,
`friends/search.ts`), pass a fake unary directly — much cleaner than
`fetch` stubbing:

```ts
const calls: Array<{ method: string; req: unknown }> = [];
const fakeUnary = async (method: any, req: any) => {
  calls.push({ method: method.methodName, req });
  return cannedResponse;
};
await addFriends(fakeUnary, /* ... */);
expect(calls).toHaveLength(1);
expect(calls[0].method).toBe("AddFriends");
```

### Reference

(No reference test yet — Phase 5A/5B agents own the first instances.)

### Pitfalls

- **Restore `globalThis.fetch` in `afterEach`.** If you skip this, every
  test after yours sees the stub.
- **Use the real `MemoryDataStore`** for cookie jars in NETWORK tests —
  it's pure and per-test cheap.
- **Don't stub `fetch` AND construct a real Sandbox** unless you really
  mean to test the shimmed path. The bundle's fetch goes through
  `shims/fetch.ts`, not `globalThis.fetch` directly — for those tests
  pass a sandbox-realm `globalThis.fetch` override via `setGlobal`.

---

## Pattern 4: INTEGRATION (live)

### When

The function only meaningfully runs against a real Snap account + real
bundle WASM. Examples: `client.authenticate()`, `client.messaging.sendText()`,
the full bring-up path in `api/auth/bringup.ts`, the standalone-mint in
`auth/fidelius-mint.ts`.

### Template

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SnapcapClient } from "../../src/client.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import { checkoutUser, releaseUser, type LockedUser } from "../lib/user-locker.ts";

// Required: noise suppression for benign standalone-mint setAttribute throw.
process.on("uncaughtException", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) return;
  process.stderr.write(`[uncaughtException] ${(err as Error)?.stack ?? err}\n`);
});
process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) return;
  process.stderr.write(`[unhandledRejection] ${(err as Error)?.stack ?? err}\n`);
});

let client: SnapcapClient;
let lockedUser: LockedUser;

beforeAll(async () => {
  // Optional: preferUser if a specific account is needed (e.g. for cached fixture).
  lockedUser = await checkoutUser(/* { preferUser: "..." } */);
  client = new SnapcapClient({
    dataStore: new FileDataStore(lockedUser.storagePath),
    credentials: {
      username: lockedUser.username,
      password: lockedUser.config.password,
    },
    browser: { userAgent: lockedUser.config.fingerprint.userAgent },
  });
  await client.authenticate();
}, 120_000);

afterAll(() => {
  if (lockedUser) releaseUser(lockedUser);
});

describe("INTEGRATION — <thing under test>", () => {
  test("does X end-to-end", async () => {
    // ... assertions on shape, NOT on specific identities
  }, 60_000);
});
```

### Reference

`tests/api/friends-snapshot.live.test.ts` — 1 test, ~8s warm.
`tests/api/messaging-myai.test.ts` — 1 test, ~14s with rate-limit floor.

### Anti-spam rules (READ BEFORE WRITING SEND-SHAPED INTEGRATION TESTS)

If your test sends, types, posts, adds friends, or does ANY mutation:

- Apply a `5000ms` throttle floor before any single mutation.
- Hard cap: ≤5 mutations per `bun test` run, across all tests in the file.
- Use `RECOMMENDED_THROTTLE_RULES` (export from `src/index.ts`).
- For multi-account: build a SHARED throttle gate via `createSharedThrottle`.
- Document the cap in the test file's header comment (see
  `messaging-myai.test.ts` for the pattern).

### Pitfalls

- **Always release the user in `afterAll`.** If you skip this, the lock
  leaks until the process exits. Other parallel runners block.
- **Never assert on specific friend identities.** Accounts get
  re-provisioned; `friend.username === "specific-friend"` will break.
  Assert on the shape (array length > 0, `userId` is a string of length
  > 0, etc.).
- **Cold-fresh login can take 30s.** Set `beforeAll` timeout to at least
  `120_000`.

---

## Extending the fixture system

The slice fixtures live in `tests/lib/fixtures/`. To add a new fixture
(say, a new "all-blocked" user-slice variant):

1. Add a new exported function to the right file:
   ```ts
   export function allBlockedUserSliceFixture(...): UserSlice { ... }
   ```
2. Make sure it accepts an `overrides: Partial<UserSlice> = {}` arg and
   spreads at the end (`{ ...overrides }`).
3. Make sure it returns FRESH objects (no module-scope `const x = new Map()`
   — ESLint won't catch that, but the per-instance isolation lint will).
4. Re-export from `tests/lib/fixtures/index.ts`.

If you need a slice the SDK doesn't currently type (a new `state.X` slot
the bundle adds), add the type FIRST to `src/bundle/types/`, then build
the fixture against the typed shape. NEVER add untyped `as any` slice
fixtures — the whole point is type-safe drift detection.

---

## When this playbook isn't enough

- **You need a real `vm.Context`** but no DataStore: construct a real
  `Sandbox` with no opts. `new Sandbox()` is ~50ms.
- **You need a real `Sandbox` + real DataStore** but no bundle:
  `new Sandbox({ dataStore: new MemoryDataStore() })`. ~80ms.
- **You need a real bundle but offline-only deterministic state**:
  this is what `tests/shims/multi-instance-isolation.test.ts` does.
  Don't authenticate; just construct the clients and assert on shape.

If your test crosses one of those lines AND can't fit any pattern above,
write it inline and document why in the file's header comment. Patterns
exist to be broken when the cost of conforming exceeds the benefit.
