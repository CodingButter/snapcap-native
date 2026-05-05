# SnapSDK src/ test-category audit

This file is the priority feed for Phase 5 (per-domain test fan-out). Every
src file lives in exactly one bucket below.

## Buckets

- **PURE** — testable as plain functions; no Sandbox, no fetch, no WS, no
  bundle eval. Test by importing the function and asserting `f(input) → output`.
- **STATE-DRIVEN** — depends on bundle Zustand state (or other sandbox-side
  state). Test against `MockSandbox` + a slice fixture; no real bundle load.
- **NETWORK** — touches `fetch` / WebSocket / cookies / gRPC framing. Test
  with mocked `fetch` (global stub or constructor-injected) + canned bytes.
- **LIVE-ONLY** — needs a real Snap account + real bundle WASM eval. Test
  with `withLockedUser` + a live `SnapcapClient`.

A file marked **STATE-DRIVEN** *can* also have a NETWORK or LIVE-ONLY layer
inside; the bucket is "what is the cheapest meaningful test against this
file." Files that are pure type declarations (no executable body) are
**TYPES** — listed for completeness but skipped from Phase 5.

## Counts (executable files only — types & barrel `index.ts` excluded)

| Bucket | Count |
|---|---|
| PURE          | 27 |
| STATE-DRIVEN  | 22 |
| NETWORK       | 13 |
| LIVE-ONLY     | 14 |
| TYPES (skip)  | 13 |
| BARREL (skip) |  9 |

## File-by-file

### `src/api/auth/`

| File | Bucket | Why |
|---|---|---|
| `authenticate.ts`        | LIVE-ONLY     | Top-level orchestrator; runs full restore-or-login path. |
| `auth-state.ts`          | STATE-DRIVEN  | Reads `authSlice(sandbox).userId` and storage keys. |
| `bringup.ts`             | LIVE-ONLY     | Loads the chat + accounts bundles into a sandbox. |
| `full-login.ts`          | NETWORK       | Drives WebLoginService 2-step; mock-fetchable in unit form. |
| `index.ts`               | BARREL        | Re-exports only. |
| `kickoff-messaging.ts`   | LIVE-ONLY     | Triggers bundle's messaging session bring-up. |
| `logout.ts`              | STATE-DRIVEN  | Clears specific DataStore keys + calls `authSlice.logout`. |
| `make-context.ts`        | PURE          | Wires `ClientContext` from inputs; no I/O. |
| `mint-and-initialize.ts` | LIVE-ONLY     | Mints SSO bearer + initializes bundle auth slice. |
| `mint-from-cookies.ts`   | NETWORK       | SSO redirect flow over `fetch` + cookie jar. |
| `patch-location.ts`      | STATE-DRIVEN  | Mutates `sandbox.window.location` shape. |
| `refresh.ts`             | LIVE-ONLY     | Calls `authSlice.refreshToken(reason, attestation)`. |
| `sso-ticket.ts`          | NETWORK       | Single SSO HTTP round-trip. |
| `types.ts`               | TYPES         | Pure type aliases. |

### `src/api/friends/`

| File | Bucket | Why |
|---|---|---|
| `events.ts`              | PURE          | Diff math against two snapshots; no I/O. |
| `get-users.ts`           | STATE-DRIVEN  | Reads `userSlice.publicUsers`, falls through to RPC for misses. |
| `graph-cache.ts`         | PURE          | JSON encode/decode + DataStore key lookups (use `MemoryDataStore`). |
| `index.ts`               | BARREL        | Re-exports only. |
| `interface-mutations.ts` | TYPES         | Interface-only. |
| `interface-reads.ts`     | TYPES         | Interface-only. |
| `interface-subscriptions.ts` | TYPES     | Interface-only. |
| `interface.ts`           | TYPES         | Interface-only. |
| `manager.ts`             | STATE-DRIVEN  | Class wires reads/writes/subscriptions over a `getCtx` thunk. |
| `mappers.ts`             | PURE          | `unwrapUserId`, `makeFriend`, `makeUserFromCache`, `makeReceivedRequest`, etc. — all input/output. |
| `mutations.ts`           | NETWORK       | `friendActionClient(...).addFriends(...)` etc. — wraps RPC unary. |
| `reads.ts`               | STATE-DRIVEN  | `snapshotFriends`/`listFriends` over a mocked context + slice. |
| `search.ts`              | NETWORK       | `searchUsers(rpc, ...)` over a mocked unary. |
| `snapshot-builders.ts`   | PURE          | `buildGraphSnapshot`, `buildSnapshot`, `saveGraphCacheGuarded`. |
| `subscriptions.ts`       | STATE-DRIVEN  | Subscribes to `chatStore(sandbox).subscribe`; mock store + emit deltas. |
| `types.ts`               | TYPES         | Consumer-shape types. |

### `src/api/messaging/`

| File | Bucket | Why |
|---|---|---|
| `bringup.ts`             | LIVE-ONLY     | Drives full bundle messaging-session setup. |
| `conv-ref.ts`            | PURE          | Builds `{id, str}` envelopes; deterministic conversion. |
| `index.ts`               | BARREL        | Re-exports only. |
| `interface.ts`           | TYPES         | Interface-only. |
| `internal.ts`            | TYPES         | Internal contract surface. |
| `manager.ts`             | STATE-DRIVEN  | Class with state slots + bus; mock context covers most paths. |
| `presence-bridge-init.ts`| LIVE-ONLY     | Wires presence bridge against bundle messaging session. |
| `presence-out.ts`        | STATE-DRIVEN  | Reads `presenceSlice` + drives `setAwayState`. |
| `reads.ts`               | STATE-DRIVEN  | `listConversations` walks `messagingSlice.conversations`. |
| `send.ts`                | LIVE-ONLY     | Bundle's `sends.sendText` requires real session bring-up. |
| `set-typing.ts`          | STATE-DRIVEN  | Drives `presenceSlice.broadcastTypingActivity` + slice gating. |
| `subscribe.ts`           | STATE-DRIVEN  | Subscribes to live-push events on the manager bus. |
| `types.ts`               | TYPES         | Plaintext-message + raw-envelope types. |
| `parse/batch-delta.ts`   | PURE          | Parse bytes → object; canned proto fixtures. |
| `parse/envelope.ts`      | PURE          | Parse encrypted-message envelope; pure decode. |
| `parse/index.ts`         | BARREL        | Re-exports only. |
| `parse/proto-reader.ts`  | PURE          | Inline protobuf wire-format reader. |
| `parse/sync-conversations.ts` | PURE     | Parse SyncConversations response bytes. |

### `src/api/` (loose files)

| File | Bucket | Why |
|---|---|---|
| `_context.ts`            | TYPES         | `ClientContext` interface only. |
| `_helpers.ts`            | PURE          | UUID conversions, conv-ref builders, search-user extraction. |
| `_media_upload.ts`       | NETWORK       | Bundle media upload-location + content RPC. |
| `fidelius.ts`            | LIVE-ONLY     | E2E identity; needs Fidelius WASM. |
| `media.ts`               | NETWORK       | Wraps multipart upload; mockable fetch shape. |
| `presence.ts`            | STATE-DRIVEN  | Drives `presenceSlice` thunks against the sandbox. |
| `stories.ts`             | STATE-DRIVEN  | Drives `storyManager` registry getter + slice writes. |

### `src/auth/` (legacy — slated for Phase 3 rename → `bundle/chat/standalone/`)

| File | Bucket | Why |
|---|---|---|
| `fidelius-decrypt.ts`    | LIVE-ONLY     | Bundle-session bring-up in standalone realm. |
| `fidelius-mint.ts`       | LIVE-ONLY     | Boots a SECOND chat WASM in isolated `vm.Context`. |

### `src/bundle/`

| File | Bucket | Why |
|---|---|---|
| `accounts-loader.ts`     | LIVE-ONLY     | Loads accounts bundle JS; needs vendor + sandbox. |
| `chat-loader.ts`         | LIVE-ONLY     | Loads chat bundle JS; same. |
| `chat-wasm-boot.ts`      | LIVE-ONLY     | Boots chat WASM via Embind. |
| `download.ts`            | NETWORK       | Fetches bundle tarball + sha-verifies; mockable fetch. |
| `presence-bridge.ts`     | STATE-DRIVEN  | Builds presence-bridge object the bundle's presence service consumes; can stub the duplex client surface. |
| `prime.ts`               | STATE-DRIVEN  | Webpack-cycle priming via shimmed wreq; pure walk over module map. |
| `worker-proxy-facade.ts` | STATE-DRIVEN  | Comlink-shaped facade; can stub the worker. |
| `register/auth.ts`       | STATE-DRIVEN  | Pure getter over sandbox global; one-line. |
| `register/chat.ts`       | STATE-DRIVEN  | Resolves chatStore via `chatWreq`. |
| `register/friends.ts`    | STATE-DRIVEN  | Pure getter over sandbox global. |
| `register/host.ts`       | STATE-DRIVEN  | Pure getter over sandbox global. |
| `register/index.ts`      | BARREL        | Re-exports only. |
| `register/media.ts`      | STATE-DRIVEN  | Pure getter over sandbox global. |
| `register/messaging.ts`  | STATE-DRIVEN  | Pure getter over sandbox global. |
| `register/module-ids.ts` | TYPES         | Constants only. |
| `register/patch-keys.ts` | TYPES         | Constants only. |
| `register/presence.ts`   | STATE-DRIVEN  | Slice getter + enum lookup helper. |
| `register/reach.ts`      | PURE          | `reach()` / `reachModule()` — testable with a `MockSandbox`. |
| `register/search.ts`     | STATE-DRIVEN  | Slice getter + utility. |
| `register/stories.ts`    | STATE-DRIVEN  | Pure getter over sandbox global. |
| `register/subscribe.ts`  | STATE-DRIVEN  | Subscribe wrapper around chatStore. |
| `register/user.ts`       | STATE-DRIVEN  | Pure slice getter + projector. |
| `types/*.ts`             | TYPES         | All bundle-side type declarations. |

### `src/shims/`

| File | Bucket | Why |
|---|---|---|
| `cache-storage.ts`       | STATE-DRIVEN  | DataStore-backed Cache API; test with `MemoryDataStore`. |
| `cookie-container.ts`    | STATE-DRIVEN  | happy-dom CookieContainer dispatch via WeakMap. |
| `cookie-jar.ts`          | PURE          | `getOrCreateJar(ds)` — keyed by DataStore. |
| `document-cookie.ts`     | STATE-DRIVEN  | Routes `document.cookie` through jar. |
| `fetch.ts`               | NETWORK       | The whole fetch shim; canned-response harness. |
| `indexed-db.ts`          | STATE-DRIVEN  | DataStore-backed IndexedDB; long, but pure-data API. |
| `index.ts`               | BARREL        | Re-exports + `SDK_SHIMS` array. |
| `runtime.ts`             | STATE-DRIVEN  | Per-process runtime helpers. |
| `sandbox.ts`             | STATE-DRIVEN  | Constructs a vm.Context + projects globals. Already covered by `multi-instance-isolation.test.ts`. |
| `storage-shim.ts`        | STATE-DRIVEN  | DataStore-backed Web Storage API. |
| `types.ts`               | TYPES         | `ShimContext` interface. |
| `webpack-capture.ts`     | STATE-DRIVEN  | Per-Sandbox accumulators. Already covered by `multi-instance-isolation.test.ts`. |
| `websocket.ts`           | NETWORK       | WebSocket shim factory. |
| `worker.ts`              | STATE-DRIVEN  | Synchronous Web Worker simulator. |
| `xml-http-request.ts`    | NETWORK       | XHR over native-fetch + cookie jar. |

### `src/storage/`

| File | Bucket | Why |
|---|---|---|
| `cookie-store.ts`        | PURE          | Tough-cookie jar wrapper over DataStore. |
| `data-store.ts`          | PURE          | `MemoryDataStore` / `FileDataStore`; trivially testable. |
| `idb-utils.ts`           | PURE          | IndexedDB key + record helpers. |
| `storage-shim.ts`        | PURE          | StorageShim wraps a DataStore with a key prefix. |

### `src/transport/`

| File | Bucket | Why |
|---|---|---|
| `cookies.ts`             | NETWORK       | Jar-aware fetch wrapper. |
| `native-fetch.ts`        | NETWORK       | Logging fetch ref + retry. |
| `proto-encode.ts`        | PURE          | UUID + protobuf helpers. |
| `throttle.ts`            | PURE          | Token-bucket / sliding-window math; deterministic. |

### `src/lib/` + top-level

| File | Bucket | Why |
|---|---|---|
| `lib/typed-event-bus.ts` | PURE          | Typed event bus over `EventTarget`; deterministic. |
| `client.interface.ts`    | TYPES         | Public client interface. |
| `client.ts`              | LIVE-ONLY     | Composes everything; integration target. |
| `index.ts`               | BARREL        | Public re-exports. |
| `logging.ts`             | PURE          | Console wrappers + level config. |
| `types.ts`               | TYPES         | Public types. |

## Phase 5 priority order (suggested)

Higher up = faster ROI per test file written.

1. **Friends mappers + snapshot-builders + graph-cache + events** (PURE) —
   pure functions over typed inputs, very high coverage payoff.
2. **Messaging parse/** (PURE) — canned-byte fixtures, high blast radius
   when Snap rebuilds proto shapes.
3. **api/_helpers.ts** (PURE) — UUID conversions are infra; everything
   above depends on them being correct.
4. **transport/throttle.ts + transport/proto-encode.ts** (PURE) — deterministic
   sliders + bytes.
5. **storage/** (PURE) — `MemoryDataStore`, `StorageShim`, `cookie-store`.
6. **bundle/register/** (STATE-DRIVEN, mostly trivial) — each getter is one
   `expect`; bulk-add 12 tiny tests once `MockSandbox` exists.
7. **friends/reads + friends/manager + friends/subscriptions** (STATE-DRIVEN) —
   exercise the whole subscription bridge against a fixture user-slice +
   manual `subscribe(...)` callbacks.
8. **shims/storage-shim + shims/cookie-jar + shims/cookie-container**
   (STATE-DRIVEN) — already partially covered by isolation test.
9. **NETWORK** files (fetch, search, mutations, sso-ticket, mint-from-cookies,
   media) — mock `fetch`, assert wire shape + jar handling.
10. **LIVE-ONLY** — keep small (one canonical scenario per domain). The
    `messaging-myai.test.ts` template scales to other LIVE paths via
    `checkoutUser` + `withLockedUser`.
