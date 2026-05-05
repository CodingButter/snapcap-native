/**
 * STATE-DRIVEN tests — `src/api/messaging/bringup.ts`.
 *
 * `bringUpSession` orchestrates a heavy mint + realm + setupBundleSession
 * dance. Testing it end-to-end against a real bundle is the LIVE-ONLY
 * integration test (`messaging-myai.test.ts`); here we mock at every
 * I/O boundary and assert the orchestration LAYER:
 *
 *   - mints identity, captures realm onto the slot
 *   - polls auth-slice for `userId` + `bearer` (warm + cold-fresh paths)
 *   - throws when the slice never lands a userId
 *   - throws when no bearer source is available
 *   - calls `setupBundleSession` with the right args + wires onPlaintext
 *     into `internal.events.emit("message", ...)`
 *   - `ensureSession` single-flight: a second call shares the in-flight
 *     promise; a failure resets the cell so a retry runs.
 *
 * Heavy module imports (`auth/fidelius-mint.ts`, `auth/fidelius-decrypt.ts`,
 * `bundle/register/index.ts`, `api/auth/index.ts`, `messaging/reads.ts`,
 * `shims/cookie-jar.ts`) are stubbed via `mock.module` BEFORE importing
 * `bringup.ts`. Per-test reset via `beforeEach`/`afterEach` is awkward
 * with module-scope mocks, so each test owns one orchestration assertion
 * and we verify shared state on the per-internal mutable cells.
 */
import { describe, expect, mock, test, beforeAll, afterAll } from "bun:test";
import { TypedEventBus } from "../../../src/lib/typed-event-bus.ts";
import type { MessagingEvents } from "../../../src/api/messaging/interface.ts";
import type {
  Cell,
  MessagingInternal,
  Slot,
} from "../../../src/api/messaging/internal.ts";

// ── Module stubs ────────────────────────────────────────────────────────
//
// Mocked in module scope so they apply to every dynamic + static import
// `bringup.ts` performs. The mocks expose a few mutable slots (`mock`)
// per test so individual tests can:
//   - reset call logs
//   - set the auth-slice fixture (warm-path userId vs cold-fresh + poll)
//   - stub `setupBundleSession` to capture its args + invoke onPlaintext
//
// Each mock is a thin pass-through to a per-test bag (`bag`) reset in
// `beforeEach`. Tests below build their own bag.

interface MockBag {
  /** captured `setupBundleSession` calls */
  setupCalls: Array<Record<string, unknown>>;
  /** simulator: when set, `setupBundleSession` invokes this with onPlaintext */
  emitPlaintext?: (cb: (msg: { content: Uint8Array; isSender: boolean }) => void) => void;
  /** Slice returned by `authSlice(sandbox)` for this test. */
  authSliceShape: Record<string, unknown>;
  /** Bearer returned by `getAuthToken(ctx)` (the fast-path probe). */
  getAuthTokenReturn: string;
  /** Sequence of slice mutations to apply after each poll-tick (cold-fresh). */
  authSliceMutations: Array<(shape: Record<string, unknown>) => void>;
  /** Captured listConversations call args. */
  listConvsCalls: Array<{ ctx: unknown; userId: string }>;
  /** Conv list to return from listConversations. */
  listConvsReturn: Array<{ conversationId: string; type: number; participants: string[] }>;
  /** Should listConversations throw? (best-effort path) */
  listConvsThrow?: Error;
  /** mintFideliusIdentity invocation counter */
  mintCalls: number;
  /** getStandaloneChatRealm invocation counter */
  realmCalls: number;
  /** Realm to return */
  realmShape: { context: object };
  /** fetchUserData invocation counter */
  fetchUserDataCalls: number;
}

let bag: MockBag = freshBag();

function freshBag(): MockBag {
  return {
    setupCalls: [],
    authSliceShape: {},
    getAuthTokenReturn: "",
    authSliceMutations: [],
    listConvsCalls: [],
    listConvsReturn: [],
    mintCalls: 0,
    realmCalls: 0,
    realmShape: { context: {} },
    fetchUserDataCalls: 0,
  };
}

// `bringup.ts` pulls all three of these from the standalone barrel —
// mock.module needs to match that single import target.
mock.module("../../../src/bundle/chat/standalone/index.ts", () => ({
  mintFideliusIdentity: async (_sb: unknown) => {
    bag.mintCalls++;
    return { /* identity blob — bringup doesn't read it */ };
  },
  getStandaloneChatRealm: async (_sb: unknown) => {
    bag.realmCalls++;
    return bag.realmShape;
  },
  setupBundleSession: async (opts: Record<string, unknown>) => {
    bag.setupCalls.push(opts);
    if (bag.emitPlaintext) {
      bag.emitPlaintext(opts.onPlaintext as (m: { content: Uint8Array; isSender: boolean }) => void);
    }
    if (typeof opts.onSession === "function") {
      (opts.onSession as (s: unknown) => void)({ /* mocked session */ });
    }
  },
}));

mock.module("../../../src/shims/cookie-jar.ts", () => ({
  getOrCreateJar: (_ds: unknown) => ({ /* fake jar */ }),
}));

mock.module("../../../src/api/messaging/reads.ts", () => ({
  listConversations: async (ctx: unknown, userId: string) => {
    bag.listConvsCalls.push({ ctx, userId });
    if (bag.listConvsThrow) throw bag.listConvsThrow;
    return bag.listConvsReturn;
  },
  getSelfUserId: async () => "00000000-0000-0000-0000-000000000000",
}));

// Stub the entire bundle/register barrel — superset that satisfies BOTH
// this file's needs (authSlice) AND `presence-bridge-init.test.ts`'s
// needs (presenceSlice + chatStore). `mock.module` is process-global and
// last-write-wins; co-locating ensures whichever file loads last sees a
// complete-enough surface.
mock.module("../../../src/bundle/register/index.ts", () => ({
  authSlice: (_sb: unknown) => {
    // Apply one queued mutation per call (simulates Zustand setState
    // landing while we poll).
    const m = bag.authSliceMutations.shift();
    if (m) m(bag.authSliceShape);
    return bag.authSliceShape;
  },
  // Stubs unused by THIS file — present so a sibling test file that
  // needs them isn't silently shadowed when both load in the same `bun
  // test` run.
  presenceSlice: (_sb: unknown) => ({
    initializePresenceServiceTs: () => {},
    createPresenceSession: () => () => {},
    presenceSession: undefined,
  }),
  chatStore: (_sb: unknown) => ({
    getState: () => ({}),
    setState: () => {},
    subscribe: () => () => {},
  }),
}));

mock.module("../../../src/api/auth/index.ts", () => ({
  getAuthToken: (_ctx: unknown) => bag.getAuthTokenReturn,
}));

// ── Imports happen AFTER the mocks above are registered ──────────────────
let bringUpSession: typeof import("../../../src/api/messaging/bringup.ts").bringUpSession;
let ensureSession: typeof import("../../../src/api/messaging/bringup.ts").ensureSession;

beforeAll(async () => {
  const mod = await import("../../../src/api/messaging/bringup.ts");
  bringUpSession = mod.bringUpSession;
  ensureSession = mod.ensureSession;
});

// `mock.module` calls above are process-global. Without this teardown the
// reads/register/auth/cookie-jar/fidelius stubs would still be in place
// when sibling test files (e.g. `reads.test.ts`) load and import the real
// modules, returning the stubbed exports instead. `mock.restore()` does
// undo `mock.module` registrations as of bun 1.3.x — verified via a probe
// before adding this hook.
afterAll(() => mock.restore());

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build a `MessagingInternal` for a test. Every cell/slot/event-bus is
 * fresh so two parallel tests never collide.
 */
function buildInternal(opts: { userAgent?: string } = {}): {
  internal: MessagingInternal;
  events: TypedEventBus<MessagingEvents>;
  realmSlot: Slot<unknown>;
  sessionSlot: Slot<unknown>;
  presenceInit: Cell<boolean>;
} {
  const events = new TypedEventBus<MessagingEvents>();
  let realmRef: unknown;
  let sessionRef: unknown;
  const realmSlot: Slot<unknown> = {
    get: () => realmRef,
    set: (v) => { realmRef = v; },
  };
  const sessionSlot: Slot<unknown> = {
    get: () => sessionRef,
    set: (v) => { sessionRef = v; },
  };
  const presenceInit: Cell<boolean> = { value: false };
  const internal: MessagingInternal = {
    ctx: async () => ({
      sandbox: {} as unknown,
      jar: {} as unknown,
      dataStore: { /* fake DS */ } as unknown,
      userAgent: opts.userAgent ?? "test-ua/1.0",
    } as Parameters<MessagingInternal["ctx"]> extends [] ? Awaited<ReturnType<MessagingInternal["ctx"]>> : never),
    events,
    ensureSession: async () => {},
    session: sessionSlot as unknown as Slot<NonNullable<ReturnType<Slot<unknown>["get"]>>>,
    realm: realmSlot as unknown as Slot<NonNullable<ReturnType<Slot<unknown>["get"]>>>,
    presenceInitialized: presenceInit,
    presenceSessions: new Map(),
  } as unknown as MessagingInternal;
  return { internal, events, realmSlot, sessionSlot, presenceInit };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("messaging/bringup — bringUpSession (warm path)", () => {
  test("happy path: mints, captures realm, calls setupBundleSession", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "11111111-1111-1111-1111-111111111111",
      authToken: { token: "warm-bearer" },
    };
    bag.getAuthTokenReturn = "warm-bearer";
    bag.listConvsReturn = [
      { conversationId: "aaaaaaaa-1111-1111-1111-111111111111", type: 5, participants: [] },
      { conversationId: "bbbbbbbb-2222-2222-2222-222222222222", type: 13, participants: [] },
    ];
    const { internal, realmSlot } = buildInternal();
    await bringUpSession(internal);

    expect(bag.mintCalls).toBe(1);
    expect(bag.realmCalls).toBe(1);
    expect(realmSlot.get()).toBe(bag.realmShape);
    expect(bag.setupCalls).toHaveLength(1);
    const opts = bag.setupCalls[0]!;
    expect(opts.bearer).toBe("warm-bearer");
    expect(opts.userId).toBe("11111111-1111-1111-1111-111111111111");
    expect(opts.userAgent).toBe("test-ua/1.0");
    expect(opts.conversationIds).toEqual([
      "aaaaaaaa-1111-1111-1111-111111111111",
      "bbbbbbbb-2222-2222-2222-222222222222",
    ]);
  });

  test("wires onPlaintext into events.emit('message', ...)", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "22222222-2222-2222-2222-222222222222",
      authToken: { token: "tok-2" },
    };
    bag.getAuthTokenReturn = "tok-2";
    bag.emitPlaintext = (cb) => {
      cb({ content: new TextEncoder().encode("hello"), isSender: false } as unknown as Parameters<typeof cb>[0]);
    };
    const { internal, events } = buildInternal();
    const received: Array<unknown> = [];
    events.on("message", (msg) => received.push(msg));
    await bringUpSession(internal);
    expect(received).toHaveLength(1);
    const msg = received[0] as { content: Uint8Array; isSender: boolean };
    expect(new TextDecoder().decode(msg.content)).toBe("hello");
    expect(msg.isSender).toBe(false);
  });

  test("captures the bundle session via onSession callback", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "33333333-3333-3333-3333-333333333333",
      authToken: { token: "tok-3" },
    };
    bag.getAuthTokenReturn = "tok-3";
    const { internal, sessionSlot } = buildInternal();
    await bringUpSession(internal);
    expect(sessionSlot.get()).toBeDefined();
  });

  test("falls back to empty conversationIds when listConversations throws", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "44444444-4444-4444-4444-444444444444",
      authToken: { token: "tok-4" },
    };
    bag.getAuthTokenReturn = "tok-4";
    bag.listConvsThrow = new Error("rpc fell over");
    const { internal } = buildInternal();
    await bringUpSession(internal);
    expect(bag.setupCalls[0]!.conversationIds).toEqual([]);
  });
});

describe("messaging/bringup — bringUpSession (cold-fresh path)", () => {
  test("polls the auth slice until userId lands", async () => {
    bag = freshBag();
    // Slice starts with no userId, no token — gets populated on poll
    // tick 3 (after ~300ms). The fast-path bearer probe still kicks in
    // via getAuthTokenReturn.
    bag.authSliceShape = { /* nothing yet */ };
    bag.getAuthTokenReturn = "fast-bearer";
    bag.authSliceMutations = [
      // tick 1 → still empty
      () => {},
      // tick 2 → still empty
      () => {},
      // tick 3 → userId lands
      (s) => {
        s.userId = "55555555-5555-5555-5555-555555555555";
        s.authToken = { token: "slice-bearer" };
      },
    ];
    const { internal } = buildInternal();
    await bringUpSession(internal);
    expect(bag.setupCalls).toHaveLength(1);
    expect(bag.setupCalls[0]!.userId).toBe("55555555-5555-5555-5555-555555555555");
  });

  test("invokes fetchUserData on the slice when present (kicks the bundle)", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "66666666-6666-6666-6666-666666666666",
      authToken: { token: "tok-6" },
      fetchUserData: (_src?: string) => {
        bag.fetchUserDataCalls++;
        return Promise.resolve();
      },
    };
    bag.getAuthTokenReturn = "tok-6";
    const { internal } = buildInternal();
    await bringUpSession(internal);
    expect(bag.fetchUserDataCalls).toBeGreaterThanOrEqual(1);
  });

  test("falls back to slice.me.userId when slice.userId is missing", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      me: { userId: "77777777-7777-7777-7777-777777777777" },
      authToken: { token: "me-bearer" },
    };
    bag.getAuthTokenReturn = "me-bearer";
    const { internal } = buildInternal();
    await bringUpSession(internal);
    expect(bag.setupCalls[0]!.userId).toBe("77777777-7777-7777-7777-777777777777");
  });
});

describe("messaging/bringup — bringUpSession (failure paths)", () => {
  test("throws after 30s when the auth slice never lands a userId", async () => {
    bag = freshBag();
    bag.authSliceShape = { /* permanent empty */ };
    bag.getAuthTokenReturn = "still-bearer";
    const { internal } = buildInternal();
    // Fast simulation: keep poll tight by not setting any mutations.
    // Real wall-clock cost: ~30s. Allow generous timeout.
    await expect(bringUpSession(internal)).rejects.toThrow(/no userId after 30s/);
  }, 45_000);

  test("throws when no bearer is available from any source", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "88888888-8888-8888-8888-888888888888",
      // no authToken on slice
    };
    bag.getAuthTokenReturn = ""; // empty → falsy
    const { internal } = buildInternal();
    await expect(bringUpSession(internal)).rejects.toThrow(/no bearer/);
  }, 45_000);
});

describe("messaging/bringup — ensureSession (single-flight)", () => {
  test("first call kicks bring-up; second concurrent call awaits the same promise", async () => {
    bag = freshBag();
    bag.authSliceShape = {
      userId: "99999999-9999-9999-9999-999999999999",
      authToken: { token: "tok-9" },
    };
    bag.getAuthTokenReturn = "tok-9";
    const { internal } = buildInternal();
    const cell: Cell<Promise<void> | undefined> = { value: undefined };
    const p1 = ensureSession(internal, cell);
    const p2 = ensureSession(internal, cell);
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    // Bring-up ran exactly ONCE despite two ensureSession calls.
    expect(bag.mintCalls).toBe(1);
    expect(bag.setupCalls).toHaveLength(1);
  });

  test("a failed bring-up resets the cell so a retry can run", async () => {
    bag = freshBag();
    // Force the first run to throw — empty bearer + no token.
    bag.authSliceShape = { userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
    bag.getAuthTokenReturn = "";
    const { internal } = buildInternal();
    const cell: Cell<Promise<void> | undefined> = { value: undefined };
    await expect(ensureSession(internal, cell)).rejects.toThrow(/no bearer/);
    expect(cell.value).toBeUndefined(); // reset for retry

    // Second call now succeeds because we set a real bearer.
    bag.getAuthTokenReturn = "now-i-have-a-bearer";
    bag.authSliceShape = {
      userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      authToken: { token: "now-i-have-a-bearer" },
    };
    await ensureSession(internal, cell);
    // Two distinct setup calls: failure path, then retry.
    expect(bag.setupCalls).toHaveLength(1);
  }, 60_000);
});
