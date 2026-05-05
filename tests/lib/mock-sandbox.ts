/**
 * mock-sandbox.ts — duck-typed `Sandbox` substitute for STATE-DRIVEN tests.
 *
 * # Purpose
 *
 * The real `Sandbox` (`src/shims/sandbox.ts`) wraps a `vm.Context` plus
 * happy-dom Window plus a stack of shims plus per-instance bring-up caches.
 * Constructing a real one in a unit test is heavy (~150-200ms cold) and
 * brings in WebAssembly + happy-dom DOM init that we rarely care about for
 * a focused test of (say) `friends/snapshot-builders.ts`.
 *
 * `MockSandbox` is a thin duck-typed substitute that satisfies the SAME
 * structural shape consumer code expects (`getGlobal<T>`, `setGlobal`,
 * `runInContext`, `webpackCapture` slot, etc.) so callers don't need a
 * special "test mode" branch. Every consumer that reaches into a sandbox
 * via the registry pattern (`chatStore(sandbox)`, `userSlice(sandbox)`,
 * `presenceSlice(sandbox)`, …) goes through `getGlobal()` on this object,
 * so once you stub the right keys the real api code paths run unchanged.
 *
 * # API
 *
 * Builder, fluent, return-fresh-per-test. No globals. No Sandbox.constructor
 * involvement.
 *
 * ```ts
 * const sandbox = mockSandbox()
 *   .withGlobal("__SNAPCAP_AUTH_SLICE", authSliceFixture({ userId: "..." }))
 *   .withChatStore({
 *     auth: authSliceFixture(),
 *     user: userSliceFixture({ mutuallyConfirmedFriendIds: [...] }),
 *     // ...
 *   })
 *   .build();
 *
 * // Then pass to anything taking a `Sandbox`:
 * const friends = userSlice(sandbox);
 * expect(friends.mutuallyConfirmedFriendIds.length).toBe(2);
 * ```
 *
 * The `.withChatStore(state)` shortcut wires `sandbox.getGlobal("__snapcap_chat_p")`
 * (the chat webpack require) so `reachModule(sandbox, MOD_CHAT_STORE, ...)`
 * resolves a fake module exporting a tiny in-memory Zustand-like store.
 * Combined with slice fixtures, this covers the bulk of friends/messaging/
 * presence STATE-DRIVEN test paths without booting WASM.
 *
 * # Type strategy
 *
 * `MockSandbox` is typed as `Pick<Sandbox, ...the methods consumers touch>`
 * via a structural alias rather than `extends Sandbox` because:
 *   - We don't want to construct the real Sandbox at all (costs an empty
 *     vm.Context per test).
 *   - The compile-time guarantee we want is "consumer code that takes
 *     `sandbox: Sandbox` accepts our mock", and structural typing on the
 *     methods it actually uses is the lighter contract.
 *
 * The mock satisfies the same fields consumer code references:
 * `getGlobal`, `setGlobal`, `runInContext`, `window`, `document`,
 * `context`, `hdWindow`, `throttleGate`, plus the per-instance bring-up
 * caches (`webpackCapture`, `kameleonBoot`, …) consumer code rarely
 * touches but `Sandbox`-typed parameters require.
 *
 * The `.build()` return is `cast as unknown as Sandbox` — the cast lives
 * in ONE place and is documented here.
 *
 * # Per-test isolation
 *
 * `mockSandbox()` returns a fresh builder each call. `.build()` returns a
 * fresh object each call. No module-scope state. Two tests that both
 * `.withChatStore({...})` get distinct stores, even with identical fixtures.
 *
 * # What this mock does NOT do
 *
 * - No vm.Context realm. Cross-realm `instanceof Uint8Array` works
 *   trivially because everything is host-realm.
 * - No bundle JS eval. Source-patched `__SNAPCAP_*` keys must be stubbed
 *   explicitly via `withGlobal` (which is the whole point — you control
 *   what the bundle "would have" exposed).
 * - No automatic shim install. There's no DOM. Tests that need
 *   `document.cookie` or `localStorage` should construct a REAL `Sandbox`
 *   with a `MemoryDataStore`.
 *
 * If your test crosses one of those lines, drop down to a real `Sandbox`
 * constructor (still cheap when no bundle is loaded).
 */
import type { Sandbox } from "../../src/shims/sandbox.ts";
import type {
  AuthSlice,
  ChatState,
  ChatStore,
  MessagingSlice,
  PresenceSlice,
  UserSlice,
} from "../../src/bundle/types/index.ts";
import { MOD_CHAT_STORE } from "../../src/bundle/register/module-ids.ts";

/**
 * Listener bag tracked per mocked chat-store instance.
 *
 * `MockChatStore` mimics `subscribe(listener)` so subscription tests
 * (e.g. `friends/subscriptions.ts`) can drive deltas via the test-only
 * `emit(prevState)` helper exposed alongside `setState`.
 */
type StoreListener<T> = (state: T, prev: T) => void;

/**
 * Test-side handle on the mocked chat store. Exposes both the read
 * surface the bundle's `ChatStore` interface declares AND a `_emit`
 * helper for tests that want to drive subscription callbacks manually
 * after stubbing initial state.
 *
 * Returned from {@link MockSandboxBuilder.withChatStore} so tests can
 * grab the handle and drive `setState` / `_emit` from the test body.
 */
export interface MockChatStore<T = ChatState> extends ChatStore<T> {
  /**
   * Test-only: invoke every subscribed listener with `(currentState, prev)`.
   * Use to simulate a bundle-side state mutation that subscribers should
   * react to. The listener-side path is what `friends/subscriptions.ts`
   * and `bundle/register/subscribe.ts` build on.
   */
  _emit(prev: T): void;
}

/**
 * Construct a fresh {@link MockChatStore} backed by `initial`. The store
 * carries an internal listener array; `subscribe` returns an unsubscribe
 * thunk; `_emit(prev)` fans the current state to every subscriber.
 *
 * @param initial - Starting state shape — typically a {@link ChatState}
 *   composed from fixture functions in `tests/lib/fixtures/`.
 * @returns A live {@link MockChatStore}.
 *
 * @internal Exposed via {@link MockSandboxBuilder.withChatStore}; rarely
 * constructed directly.
 */
export function makeMockChatStore<T extends object = ChatState>(initial: T): MockChatStore<T> {
  let state = initial;
  const listeners: Array<StoreListener<T>> = [];

  return {
    getState: () => state,
    setState: (updater) => {
      const next = typeof updater === "function"
        ? { ...state, ...(updater as (s: T) => Partial<T>)(state) }
        : { ...state, ...updater };
      const prev = state;
      state = next as T;
      for (const l of listeners) l(state, prev);
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    _emit: (prev) => {
      for (const l of listeners) l(state, prev);
    },
  };
}

/**
 * Mutable build state for {@link MockSandboxBuilder}.
 *
 * @internal
 */
interface BuilderState {
  globals: Map<string, unknown>;
  chatStore?: MockChatStore;
}

/**
 * Fluent builder for a {@link MockSandbox}. Each `.with*` call returns
 * `this` so callers can chain. `.build()` materializes the final Sandbox-
 * shaped object.
 *
 * Builder state is held on the instance (no module-scope mutation), so
 * two parallel `mockSandbox()` chains never collide.
 */
export class MockSandboxBuilder {
  /** @internal */
  private state: BuilderState = { globals: new Map() };

  /**
   * Stub a value the consumer code will read via `sandbox.getGlobal(key)`.
   *
   * @param key - sandbox-global key name (e.g. `"__SNAPCAP_LOGIN_CTOR"`)
   * @param value - whatever the consumer expects to be there
   * @returns this builder, for chaining
   */
  withGlobal<T>(key: string, value: T): this {
    this.state.globals.set(key, value);
    return this;
  }

  /**
   * Bulk-stub multiple `getGlobal` keys at once.
   *
   * @param map - object whose keys become sandbox-global keys
   * @returns this builder, for chaining
   */
  withGlobals(map: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(map)) this.state.globals.set(k, v);
    return this;
  }

  /**
   * Wire a fake chat-bundle Zustand store under the source-patched
   * `__snapcap_chat_p` webpack require, so consumers that go through
   * `chatStore(sandbox).getState()` resolve a real in-memory store.
   *
   * Internally:
   *   - constructs a `MockChatStore` from `initial`
   *   - stubs `getGlobal("__snapcap_chat_p")` to a function whose `(id)`
   *     call returns `{ M: <the store> }` for {@link MOD_CHAT_STORE}
   *   - the wreq function exposes `.m` (factory map) for any test that
   *     wants to extend it
   *
   * @param initial - chat state shape (typically composed from
   *   `authSliceFixture()`, `userSliceFixture()`, etc.)
   * @returns this builder, for chaining
   *
   * @example
   * ```ts
   * const sandbox = mockSandbox()
   *   .withChatStore({
   *     auth: authSliceFixture(),
   *     user: userSliceFixture({ mutuallyConfirmedFriendIds: ["abc"] }),
   *     presence: presenceSliceFixture(),
   *     messaging: messagingSliceFixture(),
   *   })
   *   .build();
   * ```
   */
  withChatStore<T extends object = ChatState>(initial: T): this {
    const store = makeMockChatStore<T>(initial);
    this.state.chatStore = store as unknown as MockChatStore;

    // Build a wreq-shaped function: callable with a moduleId, returns the
    // module export object. Real bundle modules export their public
    // surface as `.M` (Zustand store factory); we replicate that shape so
    // `reachModule(sandbox, MOD_CHAT_STORE, ...)` resolves cleanly.
    const factories: Record<string, () => unknown> = {
      [MOD_CHAT_STORE]: () => ({ M: store }),
    };
    const wreq = ((id: string): unknown => {
      const f = factories[id];
      if (!f) throw new Error(`MockSandbox wreq: no module ${id} stubbed`);
      return f();
    }) as unknown as { (id: string): unknown; m: Record<string, Function> };
    // `.m` keeps the same shape consumer code may walk (factory map).
    (wreq as { m: Record<string, Function> }).m = factories;

    this.state.globals.set("__snapcap_chat_p", wreq);
    return this;
  }

  /**
   * Materialize the {@link MockSandbox}. Returns a `Sandbox`-shaped object
   * ready to pass to consumer functions.
   *
   * The single `as unknown as Sandbox` cast lives here. Consumer code
   * sees a structurally-compatible Sandbox; the bring-up cache slots
   * (`kameleonBoot`, `chatBundleLoaded`, `chatWasmBoot`, `fideliusMintBoot`,
   * `webpackCapture`) start undefined, matching a fresh real Sandbox.
   *
   * @returns A frozen-feeling `Sandbox`-shaped object suitable for
   * passing into any consumer function that takes `sandbox: Sandbox`.
   * Returns the chat store handle as a side-property (`._chatStore`)
   * for tests that want to drive subscription deltas.
   */
  build(): MockSandbox {
    const globals = this.state.globals;
    const chatStoreHandle = this.state.chatStore;

    // Minimal stub object — every method/field consumer code might touch.
    const sandboxLike = {
      // Read/write the global map.
      getGlobal: <T>(key: string): T | undefined => globals.get(key) as T | undefined,
      setGlobal: (key: string, value: unknown): void => { globals.set(key, value); },

      // No vm.Context — return whatever the test passes in. Tests rarely
      // need to drive runInContext; if they do, override via withGlobal +
      // a function. Throwing is the explicit "don't reach here" signal.
      runInContext: (_source: string, _filename?: string): unknown => {
        throw new Error(
          "MockSandbox.runInContext: no vm.Context in mock sandbox. " +
          "Construct a real `Sandbox` if your code needs to eval source.",
        );
      },

      // Empty `window` — host-realm plain object. Consumer code that
      // does `sandbox.window.X` reads the same Map we use for globals
      // (via property dispatch); for code that walks `window` heavily,
      // construct a real Sandbox.
      window: new Proxy({}, {
        get: (_t, key) => globals.get(String(key)),
        set: (_t, key, value) => { globals.set(String(key), value); return true; },
      }) as Record<string, unknown>,

      // No-op throttle — test code never gates on it.
      throttleGate: async (_url: string): Promise<void> => {},

      // Stubs for the per-instance bring-up cache slots. Consumer code
      // sometimes checks `if (sandbox.chatBundleLoaded)` short-circuits;
      // start undefined / false (matches a fresh Sandbox).
      chatBundleLoaded: false,
      chatRuntimeLoaded: false,
      kameleonBoot: undefined as unknown,
      chatWasmBoot: undefined as unknown,
      fideliusMintBoot: undefined as unknown,
      webpackCapture: undefined as unknown,

      // happy-dom Window stand-in — empty object. Consumer code that
      // reaches `sandbox.hdWindow.document` should construct a real
      // Sandbox; this stub exists just so structural typing matches.
      hdWindow: {} as unknown,

      // vm.Context stand-in — same rationale as `hdWindow`.
      context: {} as unknown,

      // Cross-realm bytes copier — host-realm Uint8Array IS the realm,
      // so identity passthrough is correct.
      toVmU8: (bytes: Uint8Array | ArrayBufferView): Uint8Array => {
        return bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },

      // `document` — bare object. Consumer code that mutates this should
      // use a real Sandbox.
      document: {} as unknown,

      // ── Test-only side-channels (not on real Sandbox) ────────────
      _chatStore: chatStoreHandle,
    };

    return sandboxLike as unknown as MockSandbox;
  }
}

/**
 * The duck-typed mock-sandbox shape, with the extra test-only side-channel
 * for the underlying chat store handle.
 *
 * Tests interact with consumer api code via the `Sandbox`-typed surface,
 * but can still grab `sandbox._chatStore` to drive `setState` / `_emit`
 * for subscription tests.
 */
export interface MockSandbox extends Sandbox {
  /** Test-only handle on the mocked chat store, when one was wired. */
  _chatStore?: MockChatStore;
}

/**
 * Entry point for building a {@link MockSandbox}. Each call returns a
 * fresh builder — no shared state.
 *
 * @returns A new {@link MockSandboxBuilder}.
 *
 * @example
 * ```ts
 * import { mockSandbox } from "../lib/mock-sandbox.ts";
 * import { userSliceFixture } from "../lib/fixtures/user-slice.ts";
 *
 * const sandbox = mockSandbox()
 *   .withChatStore({
 *     auth: { initialize: async () => {}, logout: async () => {}, refreshToken: async () => {} },
 *     user: userSliceFixture({
 *       mutuallyConfirmedFriendIds: ["aaa", "bbb"],
 *     }),
 *     presence: presenceSliceFixture(),
 *     messaging: messagingSliceFixture(),
 *   })
 *   .build();
 *
 * const slice = userSlice(sandbox);
 * expect(slice.mutuallyConfirmedFriendIds).toHaveLength(2);
 * ```
 */
export function mockSandbox(): MockSandboxBuilder {
  return new MockSandboxBuilder();
}

// Re-export some often-used slice types for ergonomic test imports.
export type { AuthSlice, ChatState, MessagingSlice, PresenceSlice, UserSlice };
