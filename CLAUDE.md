# SnapSDK — `@snapcap/native`

Public, MIT-licensed Node SDK that talks to `web.snapchat.com` natively. Sibling project `SnapAutomate/` (private) consumes this as a dependency.

> **Pre-read:** the parent `~/snapcap/CLAUDE.md` summarizes the layout. The `docs/internals/` chapters are the long-form story of how everything works (architecture, kameleon, webpack-trick, sso-flow, why-it-works).

> **Active refactor in progress:** see [`.claude/refactor-status.md`](.claude/refactor-status.md) for the canonical phase tracker — what's done, what's next, and the lessons learned along the way (model choice, worktree-base quirk, dynamic-import gotcha, user-locker pattern, verification gates). Read this BEFORE making structural changes to `src/` or dispatching new refactor agents.

## What works today

- `new SnapcapClient({ dataStore, credentials: { username, password } })` — per-instance ctor; sandbox installs eagerly so the standalone-realm Fidelius mint reuses cached state on warm runs.
- `await client.authenticate()` — cold/warm orchestrator; cold ~5s, warm sub-second. `client.isAuthenticated()` reports current state.
- `await client.logout(force?)` — clears `cookie_jar`, `session_snapcap_bearer`, `local_snapcap_self`, `indexdb_snapcap__fidelius__identity`, plus the persisted Fidelius identity in `local_uds.e2eeIdentityKey.shared`.
- `client.friends` — `sendRequest`, `acceptRequest`, `rejectRequest`, `remove`, `block`, `unblock`, `list`, `receivedRequests`, `sentRequests`, `snapshot`, `refresh`, `search`, `getUsers`, `onChange`, `on(event, handler)`. See `src/api/friends/interface.ts`.
- `client.messaging` — `getConversations`, `sendText`, `sendImage`, `sendImageWithCaption`, `setTyping` (stub today — wires to bundle when presence delegate lands), `subscribe`, `on(event, handler)`. See `src/api/messaging/interface.ts`.
- `client.stories.post(bytes)` — bundle auto-normalizes the Blob to 1080×1920 RGBA PNG and dispatches to MY_STORY; the SDK passes raw bytes through.
- `client.presence` — typing/viewing outbound via persistent duplex WS, with kick detection.
- `client.media` — upload-location + content endpoints for raw uploads outside the messaging path.
- All persistence routes through standard browser APIs (`localStorage` / `sessionStorage` / `indexedDB` / `document.cookie`) inside an isolated `vm.Context`; consumers plug in any `DataStore` impl. Fidelius identity persists across warm runs (verified — see `.claude/refactor-status.md`).

End-to-end smoke against a real account: `bun test tests/api/messaging-myai.test.ts` (uses the per-user locker; needs `.tmp/configs/<username>.config.json` + `.tmp/storage/<username>.json`). For a quick auth-only check: `bun test tests/api/auth-authenticate.live.test.ts`.

## Layout

The feature-folder refactor (Phases 1–6, completed 2026-05-05) split most monoliths into per-concern siblings under thematic dirs with `index.ts` barrels. See [`.claude/refactor-status.md`](.claude/refactor-status.md) for the phase-by-phase log.

```
src/
  client.ts                       ← SnapcapClient (public entry point)
  client.interface.ts             ← ISnapcapClient
  index.ts                        ← public exports
  types.ts                        ← top-level public types
  logging.ts                      ← Logger + log() (single allowlisted singleton)
  lib/
    typed-event-bus.ts            ← typed pub/sub used by managers
  api/
    _context.ts                   ← ClientContext (per-instance state)
    _helpers.ts                   ← UUID + bundle-shape adapters
    _media_upload.ts              ← upload-location + content endpoints + realm helpers
    fidelius.ts                   ← FideliusIdentityService.InitializeWebKey
    media.ts                      ← consumer-facing media helpers
    presence.ts                   ← deprecated shim, will fold into messaging/
    stories.ts                    ← MY_STORY post pipeline
    auth/
      authenticate.ts             ← cold/warm orchestrator (login → mint → ctx)
      auth-state.ts               ← bearer + userId getters off the bundle slice
      bringup.ts                  ← post-auth bring-up sequence
      full-login.ts               ← WebLoginService 2-step (username/password → cookies)
      kickoff-messaging.ts        ← FideliusIdentityService.InitializeWebKey + persist
      logout.ts                   ← clears persisted state
      make-context.ts             ← ClientContext factory
      mint-and-initialize.ts      ← bearer mint orchestration
      mint-from-cookies.ts        ← bearer mint from existing parent-domain cookies
      patch-location.ts           ← happy-dom location → web.snapchat.com proxy
      refresh.ts                  ← bearer refresh on 401
      sso-ticket.ts               ← SSO redirect dance → ticket
      types.ts                    ← AuthCallbacks etc
      index.ts                    ← barrel
    friends/
      manager.ts                  ← Friends class (sendRequest/remove/block/snapshot/...)
      interface.ts                ← IFriendsManager (composed from sub-interfaces)
      interface-{mutations,reads,subscriptions}.ts
      reads.ts / mutations.ts / search.ts / get-users.ts
      mappers.ts                  ← bundle-shape → consumer-shape
      snapshot-builders.ts        ← FriendsSnapshot composition
      graph-cache.ts / events.ts / subscriptions.ts / types.ts
      index.ts                    ← barrel
    messaging/
      manager.ts                  ← Messaging facade
      interface.ts                ← IMessagingManager + MessagingEvents
      internal.ts                 ← per-instance MessagingInternal cell + slot
      bringup.ts                  ← session bring-up orchestration
      conv-ref.ts                 ← realm-local ConversationRef construction
      send.ts / set-typing.ts / presence-out.ts / reads.ts / subscribe.ts
      presence-bridge-init.ts     ← presence delegate wiring
      types.ts / index.ts
  bundle/
    chat-loader.ts                ← loads chat bundle JS into the sandbox
    chat-wasm-boot.ts             ← chat WASM init (in-sandbox instance)
    accounts-loader.ts            ← accounts bundle loader (used by login)
    download.ts                   ← downloads vendor/snap-bundle on first use
    prime.ts                      ← warmup orchestration
    presence-bridge.ts            ← inbound presence event bridging
    worker-proxy-facade.ts        ← stub for the bundle's worker.proxy contract
    register/
      index.ts                    ← `reach()` registry of source-patched bundle methods
      auth.ts / chat.ts / friends.ts / host.ts / media.ts / messaging.ts
      module-ids.ts / patch-keys.ts / presence.ts / reach.ts / search.ts / stories.ts / subscribe.ts / user.ts
    types/
      index.ts                    ← bundle-shape types barrel
      chat-store.ts / conversations.ts / friends.ts / login.ts / media.ts / messaging.ts / presence.ts / rpc.ts
    chat/
      standalone/                 ← SECOND chat WASM in isolated vm.Context (Fidelius mint + messaging session)
        index.ts                  ← barrel
        realm.ts                  ← bootStandaloneMintWasm + getStandaloneChatRealm
        identity-mint.ts          ← mintFideliusIdentity
        realm-globals.ts / types.ts
        session/
          setup.ts                ← setupBundleSession orchestration
          ws-shim.ts              ← Node-ws WebSocket + cookie pre-bind
          push-handler.ts / deliver-plaintext.ts / inbox-pump.ts
          wake-session.ts / wasm-services-init.ts / grpc-web-factory.ts
          session-args.ts / wrap-session-create.ts / register-duplex-trace.ts
          chunk-patch.ts / import-scripts.ts / id-coercion.ts
          types.ts / utils.ts / realm-globals.ts / index.ts
  transport/
    native-fetch.ts               ← per-call host fetch + observability log
    cookies.ts                    ← jar-aware fetch wrapper
    proto-encode.ts               ← uuid + protobuf helpers
    throttle.ts                   ← per-Sandbox throttle gate
  shims/
    sandbox.ts                    ← isolated vm.Context wrapping happy-dom Window
    runtime.ts                    ← installShims / getSandbox singletons
    webpack-capture.ts            ← webpack chunk-array + factory hook
    fetch.ts / xml-http-request.ts ← in-sandbox network shims (delegate to native-fetch)
    cookie-jar.ts / cookie-container.ts / document-cookie.ts ← cookie surface
    indexed-db.ts / cache-storage.ts / storage-shim.ts ← storage API surface
    websocket.ts / worker.ts      ← misc browser API surface
    types.ts / index.ts
  storage/
    data-store.ts                 ← DataStore interface, FileDataStore, MemoryDataStore
    storage-shim.ts               ← Web Storage API over a DataStore
    cookie-store.ts               ← DataStore-backed CookieJar wrapper
    idb-utils.ts                  ← idbGet / idbPut / idbDelete helpers
scripts/
  install-bundle.sh               ← downloads + verifies Snap bundle from pinned GH Release
  release-bundle.sh               ← packages vendor/snap-bundle, uploads as new release
  refresh-bundle.sh               ← refetches Snap's JS+WASM into vendor/ (dev workflow)
  worktree-init.sh                ← bootstraps a fresh worktree with vendor/ + .tmp/ symlinks
  install-hooks.sh                ← symlinks scripts/git-hooks/* into .git/hooks/
  lint-no-singletons.sh           ← guards against module-scope mutable state
  update-docs.sh                  ← regenerates docs/api/ + LLM-friendly bundles
  git-hooks/
    pre-commit / pre-push         ← (pre-push currently DISABLED — see file header)
.tmp/                             ← gitignored: per-user configs/storage, locks, scripts, recon HARs
vendor/                           ← gitignored; populated by install-bundle.sh
docs/                             ← VitePress site (deploys to GitHub Pages)
tests/                            ← bun test files; see tests/PATTERNS.md + tests/AUDIT.md
.claude/refactor-status.md        ← canonical refactor history + open follow-ups
```

## Sandbox model

Bundle JS and WASM run in an isolated Node `vm.Context`, not on Node's globalThis. The shape:

- `shims/sandbox.ts` constructs an empty `vm.Context` (so V8 fills the new realm with `Object`/`Array`/`Promise`/`WebAssembly`/…), then projects every defined own-property of a happy-dom `Window` onto that context's global. happy-dom is *not* installed via GlobalRegistrator — it never touches Node's globalThis.
- `shims/runtime.ts` exposes `installShims(opts)` (constructs the singleton Sandbox) and `getSandbox()` (reads it back). Bundle loaders (`bundle/chat-loader.ts`, `bundle/accounts-loader.ts`) eval source via `sandbox.runInContext(src, "<filename>")`. Inside, `globalThis`/`self`/`window` all resolve to the synthesized vm-realm global.
- Storage in the sandbox can be backed by a `DataStore` — pass `dataStore: …` in the shim opts and `localStorage` / `sessionStorage` become DataStore-backed `StorageShim`s. With no DataStore, happy-dom's in-memory defaults apply.
- Real network traffic (login, gRPC, media uploads) does **not** go through the sandbox. `transport/cookies.ts` and the bundle's gRPC stack use `transport/native-fetch.ts` (Node fetch) with the SDK's own cookie jar + bearer, so request behavior is observable from the host realm.

## Critical invariants

These are easy to break and hard to debug — read these before touching the relevant areas.

- **Project ALL of happy-dom Window's own props onto the sandbox.** A curated allow-list is tempting but silently leaves out things the WASM expects (e.g. `requestAnimationFrame`, `BroadcastChannel`, `MessageChannel`). When kameleon's WASM coroutines suspend on a Promise gated by a missing global, you get a busy-loop on `emscripten_get_now` (~10M calls/sec) instead of a clean error.
- **Bundle source must be IIFE-wrapped with `\n` around the source.** Snap's bundles end in a `//# sourceMappingURL=…` line comment with no trailing newline; a bare `})(…)` continuation appended to it gets eaten by the comment. Use `(function(module, exports, require) {\n` + src + `\n})(…)`.
- **Webpack runtime IIFE must be source-patched.** The runtime keeps `__webpack_require__` (`p`) closure-private. Replace `p.m=s,p.amdO={}` → `globalThis.__snapcap_p=p,p.m=s,p.amdO={}` before eval — inside the sandbox `globalThis` is the vm-realm global, so `getSandbox().getGlobal("__snapcap_p")` reads it back. Without the patch we can't address modules by id.
- **Kameleon Module needs Graphene/page/version/UAParserInstance/webAttestationServiceClientInstance set on it before instance().** The bundle's `createModule` wrapper attaches these post-factory; we replicate it manually because we call the factory directly. Missing any one → `Cannot pass non-string to std::string` at instance() time.
- **AtlasGw responseType uses `deserializeBinary`, not `decode`.** Older grpc-web style. WebLoginService (newer ts-proto style) has `decode`. The bundle's own gRPC stack handles both; we go through `bundle/register/*` rather than maintaining a parallel transport.
- **AtlasGw needs parent-domain cookies plus bearer.** Bearer alone returns 401. The SSO redirect to `www.snapchat.com/web` is what seeds `sc-a-nonce`, `_scid`, `sc_at` into the jar. Don't skip the GET-after-redirect step in `mintBearer`.
- **NO module-scope mutable state in `src/`.** Per-instance isolation is the SDK's whole multi-tenant story — two `SnapcapClient`s in one process must share NOTHING. Anti-patterns (forbidden in any `src/*.ts`): `let X = ...` at column 0, `const CACHE = new Map()` at module scope, `let activeFoo`, `globalThis.X = ...` writes (only `chat-loader.ts` source-patches the bundle). State lives on a `private`/`#`field of a per-instance class (`Messaging`, `Sandbox`, etc.), on `ClientContext`, or in a `WeakMap<Sandbox, T>` keyed by sandbox. Stateless utilities (`new TextEncoder()`), readonly constants (`ReadonlySet`), and string/number constants are exempt. Audit on demand: `bun run lint:no-singletons`. Failure mode is silent under single-client tests; surfaces only under multi-tenant load.

## What's still gated

- **Snaps (disappearing image messages, destination kind 122)** and **receiving message body content** — both gated on the same Fidelius E2E layer. The relevant primitives live in two WASMs in the chat bundle (`e4fa…wasm` ~12 MB, `ab45…wasm` ~814 KB). They are *not* encrypted — earlier we mistook Brotli content-encoding for ciphertext. They're plain WebAssembly, ready for Embind-trace reversal like kameleon. `download-bundle.sh` now passes `--compressed` so re-pulls get plaintext WASM; old vendor/ checkouts may have garbage bytes.
- **Receiving real-time push payloads** on `aws.duplex.snapchat.com`. Same Fidelius gate — once we have the primitives, the duplex WS becomes useful for inbound message bodies.

## Adding an API method (pattern)

1. Find descriptor in the chat bundle (module 74052) or accounts bundle. Grep for `methodName:"<X>"`.
2. Register the bundle handle in `src/bundle/register/<area>.ts` via the `reach()` getter pattern (late-bound so a Snap rebuild surfaces a friendly error, not a crash).
3. Create or extend the consumer-facing file in `src/api/<area>/` (or, for one-off endpoints, a flat `src/api/<area>.ts`). Translate consumer-shape inputs (UUID strings, plain numbers) to bundle-shape via `_helpers.ts`; translate bundle-shape responses back via per-domain `mappers.ts`.
4. Surface on the relevant manager (`Friends`, `Messaging`, etc.) and re-export through the manager's `index.ts` barrel. Public types go in `src/index.ts`.
5. Add tests in `tests/api/<area>/`. Pure adapters → mock-Sandbox; state-driven → mock-Sandbox + `chatStateFixture`; live integration → `withLockedUser`. See `tests/PATTERNS.md`.
6. Document in `docs/api/`.

## TODO — per-instance proxy / outbound IP rotation

`BrowserContext` already accepts (but doesn't yet thread) an `httpAgent` slot
intended for an undici Dispatcher. Wiring this lets each `SnapcapClient`
route its outbound HTTP through a different proxy — different residential IP
per tenant, which is the biggest fingerprint-diversity win we can deliver
in-process (alongside per-client UA, locale, viewport).

Plumbing (when ready):
  1. `src/types.ts` — add `httpAgent?: Dispatcher` to `BrowserContext`
     (or surface it as a top-level `SnapcapClientOpts.httpAgent` if we
     decide it's not strictly a "browser" concern).
  2. `src/shims/sandbox.ts` — accept it from opts; expose as a Sandbox
     instance field so the I/O layer can read it.
  3. `src/transport/native-fetch.ts` — `loggingFetch` accepts an optional
     dispatcher per-call (or per-Sandbox); pass through to undici via
     the fetch options' `dispatcher` field.
  4. Both shims (fetch + xhr) pass `sandbox.httpAgent` into nativeFetch
     when present.
  5. Document the pattern: residential proxy per tenant, JSON config
     pairs username + UA + proxy URL.

This delivers what process-per-tenant gives you for IP isolation, but
in-process. The remaining gap vs process-per-tenant is TLS fingerprint
diversity (Node's TLS stack is monolithic per process — would require a
custom undici Dispatcher with a different SSLContext, or going around
Node's TLS entirely). That's a bigger lift; punt unless someone needs it.

Identified 2026-05-01. Estimate: ~50 lines + docs.

## TODO — bundle-remap script for resilience to Snap rebuilds

When Snap rebuilds their bundle (re-minifies, re-numbers webpack module IDs,
renames closure-private variables), our hardcoded `__SNAPCAP_*` constants
and module IDs in `src/bundle/register/` break. Today, finding the new
locations is a manual investigation per symbol — slow.

**Proposal:** generate AND maintain a static fingerprint table that pairs
each `__SNAPCAP_*` / module-ID constant with a STRUCTURAL fingerprint of
its source (function body, value shape, etc.) with all variable names
normalized to placeholders. Most logic survives a rebuild — only the
variable names shift.

A `scripts/remap-bundle.ts` script can:
  1. Load the current vendor/snap-bundle.
  2. Parse each module's factory body into a normalized form (e.g. via
     a tiny AST walk that replaces all identifiers with `_$1`, `_$2`, …
     in declaration order).
  3. Fuzzy-match each fingerprint against current module bodies (e.g.
     normalized Levenshtein, or a structural diff).
  4. Print top-N candidates per broken constant, with similarity score
     + byte offset, so Claude (or a human) just verifies the obvious
     winner instead of grep-spelunking from scratch.

Net effect: when Snap rebuilds, remapping our ~30 constants drops from
hours of investigation to minutes of confirmation. Identified 2026-05-01.
