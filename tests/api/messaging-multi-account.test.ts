/**
 * Multi-account messaging end-to-end spec.
 *
 * **Run on demand only — DO NOT auto-run in CI.** These tests hit live
 * Snap endpoints with real accounts and are subject to anti-spam soft-blocks.
 *
 * # What this file pins down
 *
 * Two `SnapcapClient` instances (`A = perdyjamie`, `B = jamielillee`) wired
 * to a SHARED throttle gate. Tests exercise the messaging contract end-to-end:
 *
 *   - `send + receive: text`     — A.sendText surfaces on B's `message`
 *     event with `isSender === false` (THIS PASSES TODAY).
 *   - `typing presence`          — A.setTyping fires B's `typing` event
 *     (THIS FAILS TODAY — `setTyping` is a stub on outbound).
 *   - `setViewing` + `read`      — skipped pending wire-up.
 *   - `media` (image / snap)     — skipped pending wire-test.
 *   - `isolation under load`     — A and B own distinct sandboxes / WASM
 *     realms (PASSES TODAY — covered by `scripts/test-isolation.ts`).
 *
 * # Anti-spam safety belts
 *
 * The biggest risk in this file is hammering Snap and getting either account
 * captcha-walled or soft-blocked. Mitigations:
 *
 *   - SHARED throttle gate via `createSharedThrottle(...)` — both clients
 *     coordinate through a single bucket, so concurrent traffic respects the
 *     same per-method floors as a single-tenant runner.
 *   - `TEST_THROTTLE_FLOOR_MS = 5000` — explicit sleep before any send-shaped
 *     op, since messaging-session WS frames bypass the HTTP throttle gate.
 *   - HARD CAP: at most 5 send-shaped operations per `bun test` run across
 *     all tests in this file. One unskipped send today (text), one unskipped
 *     state-change (setTyping). Skipped tests do not count.
 *   - Account scope: ONLY `perdyjamie` + `jamielillee`. `jamie_qtsmith` is
 *     reserved for `tests/api/friends.test.ts`.
 *
 * # When tests fail
 *
 * Each test name maps 1:1 to one capability. A failing test is a feature
 * that needs fixing — dispatch a follow-up agent for that one capability,
 * not the whole file.
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnapcapClient } from "../../src/client.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import {
  createSharedThrottle,
  RECOMMENDED_THROTTLE_RULES,
  type PlaintextMessage,
} from "../../src/index.ts";

// ── Noise suppression ────────────────────────────────────────────────────
// The standalone-WASM mint inside the chat bundle throws a benign
// `ei.setAttribute is not a function` from a browser-only iframe init path
// during cold bring-up. The mint catches it internally (see
// `bootStandaloneMintWasm` in src/bundle/chat/standalone/realm.ts) but the throw
// surfaces here as an unhandled error / rejection in Bun's event loop,
// which would otherwise fail tests that aren't related to the actual error.
// Swallow these specific bundle-internal noise events so they don't
// pollute test verdicts.
process.on("uncaughtException", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) {
    process.stderr.write(`[suppress-bundle-noise] ${msg.slice(0, 120)}\n`);
    return;
  }
  process.stderr.write(`[uncaughtException] ${(err as Error)?.stack ?? err}\n`);
});
process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) {
    process.stderr.write(`[suppress-bundle-noise] ${msg.slice(0, 120)}\n`);
    return;
  }
  process.stderr.write(`[unhandledRejection] ${(err as Error)?.stack ?? err}\n`);
});

// ── Constants ────────────────────────────────────────────────────────────

const SDK_ROOT = join(import.meta.dir, "..", "..");
const SMOKE_PATH = join(SDK_ROOT, ".snapcap-smoke.json");

/**
 * Hard sleep before any messaging send / state-change in the tests
 * themselves. Belt-and-braces with the shared HTTP throttle gate — the
 * WS frames the bundle session emits don't pass through the gate.
 */
const TEST_THROTTLE_FLOOR_MS = 5000;

const A_USER = "perdyjamie";
const B_USER = "jamielillee";

// ── Smoke creds ──────────────────────────────────────────────────────────

type Account = {
  username: string;
  password: string;
  authPath?: string;
  browser?: { userAgent: string; viewport?: { width: number; height: number } };
};
type Smoke = { accounts: Account[] };

function pickAccount(smoke: Smoke, username: string): Account {
  const found = smoke.accounts.find((a) => a.username === username);
  if (!found) throw new Error(`account ${username} missing from .snapcap-smoke.json`);
  return found;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function decode(content: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  pollMs = 200,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(pollMs);
  }
  return pred();
}

/**
 * Wrap any send-shaped op (sendText/sendImage/sendSnap/setTyping/setViewing)
 * with the explicit floor sleep. Logs the throttle wait so test output
 * makes the safety-belt visible.
 */
async function throttledOp<T>(label: string, op: () => Promise<T>): Promise<T> {
  process.stderr.write(`[throttle] sleeping ${TEST_THROTTLE_FLOOR_MS}ms before ${label}\n`);
  await sleep(TEST_THROTTLE_FLOOR_MS);
  return await op();
}

/**
 * Reach into a SnapcapClient's hidden `_getCtx()` the same way
 * `scripts/test-isolation.ts` does — used for the isolation assertion.
 */
interface InspectableSandbox { sandbox: unknown }
async function introspectSandbox(c: SnapcapClient): Promise<unknown> {
  const ctx = await (c.friends as unknown as {
    _getCtx: () => Promise<InspectableSandbox>;
  })._getCtx();
  return ctx.sandbox;
}

// ── Fixture state ────────────────────────────────────────────────────────

let A: SnapcapClient;
let B: SnapcapClient;
let userIdA: string;
let userIdB: string;
let convId: string;

beforeAll(async () => {
  const smoke = JSON.parse(readFileSync(SMOKE_PATH, "utf8")) as Smoke;
  const acctA = pickAccount(smoke, A_USER);
  const acctB = pickAccount(smoke, B_USER);

  // SHARED throttle gate — the multi-tenant anti-spam pattern. Both
  // clients coordinate through the same bucket so the aggregate per-method
  // rate stays at the recommended human-cadence floor regardless of
  // concurrent traffic from A and B.
  const sharedThrottle = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });

  const dataStoreA = new FileDataStore(join(SDK_ROOT, acctA.authPath ?? `.tmp/auth/${A_USER}.json`));
  const dataStoreB = new FileDataStore(join(SDK_ROOT, acctB.authPath ?? `.tmp/auth/${B_USER}.json`));

  A = new SnapcapClient({
    dataStore: dataStoreA,
    credentials: { username: acctA.username, password: acctA.password },
    browser: acctA.browser ?? {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    },
    throttle: sharedThrottle,
  });
  B = new SnapcapClient({
    dataStore: dataStoreB,
    credentials: { username: acctB.username, password: acctB.password },
    browser: acctB.browser ?? {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
    throttle: sharedThrottle,
  });

  // Parallel auth — keeps cold start under ~10s for both.
  await Promise.all([A.authenticate(), B.authenticate()]);
  if (!A.isAuthenticated()) throw new Error("beforeAll: A.authenticate() ok but isAuthenticated()=false");
  if (!B.isAuthenticated()) throw new Error("beforeAll: B.authenticate() ok but isAuthenticated()=false");

  // Resolve userIds from the chat bundle's auth slice. The slice's
  // `userId` lands via Zustand setState chained off the React effect
  // graph in `auth.initialize` — usually populated within ~500ms of
  // authenticate, but warm-start paths sometimes skip the React effect
  // entirely. Fallback: hardcoded UUIDs from `.snapcap-smoke.json`
  // (these are stable).
  const FALLBACK_USER_IDS: Record<string, string> = {
    perdyjamie: "527be2ff-aaec-4622-9c68-79d200b8bdc1",
    jamielillee: "1411a45a-7c00-4c63-8caf-2f2cd05e0c19", // resolved from auth slice
  };

  const { authSlice } = await import("../../src/bundle/register/index.ts");
  const sandboxA = await introspectSandbox(A);
  const sandboxB = await introspectSandbox(B);

  // Poll up to 30s before falling back. Cold runs sometimes need closer
  // to 15s to pump the slice through the React effect graph.
  for (let i = 0; i < 300; i++) {
    const sliceA = authSlice(sandboxA as never) as { userId?: string };
    const sliceB = authSlice(sandboxB as never) as { userId?: string };
    if (sliceA.userId && sliceB.userId && sliceA.userId.length >= 32 && sliceB.userId.length >= 32) {
      userIdA = sliceA.userId;
      userIdB = sliceB.userId;
      break;
    }
    await sleep(100);
  }
  if (!userIdA || !userIdB) {
    process.stderr.write(
      `[beforeAll] WARNING: auth slice never populated userId after 30s — using hardcoded fallbacks from .snapcap-smoke.json\n`,
    );
    userIdA = userIdA || FALLBACK_USER_IDS[A_USER]!;
    userIdB = userIdB || FALLBACK_USER_IDS[B_USER]!;
  }
  if (userIdA === userIdB) {
    throw new Error("beforeAll: A.userId === B.userId — sandbox isolation broken");
  }

  // Verify mutual friendship — fixing the friend graph is OUT OF SCOPE
  // for this test. If the accounts aren't mutual, fail with a clear msg.
  const [friendsA, friendsB] = await Promise.all([A.friends.list(), B.friends.list()]);
  const aSeesB = friendsA.some((f) => f.userId === userIdB);
  const bSeesA = friendsB.some((f) => f.userId === userIdA);
  if (!aSeesB || !bSeesA) {
    throw new Error(
      `beforeAll: ${A_USER} and ${B_USER} are not mutual friends ` +
      `(A→B=${aSeesB}, B→A=${bSeesA}). Re-friend manually before running this test.`,
    );
  }

  // Find the 1:1 conversation between A and B from A's side.
  const convs = await A.messaging.listConversations(userIdA);
  const oneOnOne = convs.find((c) => {
    const set = new Set(c.participants);
    return set.size === 2 && set.has(userIdA) && set.has(userIdB);
  });
  if (!oneOnOne) {
    throw new Error(
      `beforeAll: no 1:1 conversation between ${A_USER} and ${B_USER} in A's list. ` +
      `Send one DM manually to seed the conv, then re-run.`,
    );
  }
  convId = oneOnOne.conversationId;

  // Pre-warm the bundle messaging session on BOTH clients in beforeAll.
  // Cold standalone-WASM mint inside the chat bundle throws a benign
  // `ei.setAttribute` from a browser-only iframe init that the mint catches
  // internally — but the throw still pollutes Bun's test diagnostics if it
  // fires DURING a test. By forcing bring-up here, the noise lands in
  // beforeAll where it's harmless.
  //
  // Bring-up isn't directly exposed; touch `messaging.on(...)` (no-op
  // subscribe) on each, then `setTyping` with 0ms duration to wait for
  // `#ensureSession` to settle.
  const noopUnsubA = A.messaging.on("message", () => {});
  const noopUnsubB = B.messaging.on("message", () => {});
  // setTyping awaits #ensureSession; 0ms duration completes quickly.
  await Promise.all([
    A.messaging.setTyping(convId, 0).catch(() => {}),
    B.messaging.setTyping(convId, 0).catch(() => {}),
  ]);
  noopUnsubA();
  noopUnsubB();

  process.stderr.write(`[beforeAll] A.userId=${userIdA} B.userId=${userIdB} convId=${convId}\n`);
}, 120_000);

// ─── Send + receive: text ──────────────────────────────────────────────

describe("send + receive: text", () => {
  test("A.sendText surfaces on B.on('message') as inbound within 30s", async () => {
    const tag = `e2e-text ${Date.now()}`;
    const inboundFromA: PlaintextMessage[] = [];

    B.messaging.on("message", (msg) => {
      if (msg.isSender === false) inboundFromA.push(msg);
    });

    // Give B's bundle session a head start to bring up its WS subscription
    // before A fires the send. ~3-6s cold for setupBundleSession.
    await sleep(6_000);

    await throttledOp("A.sendText", () => A.messaging.sendText(convId, tag));

    const arrived = await waitFor(
      () => inboundFromA.some((m) => decode(m.content).includes(tag)),
      30_000,
    );
    expect(arrived).toBe(true);
  }, 90_000);
});

// ─── Typing presence ───────────────────────────────────────────────────

describe("typing presence", () => {
  test("A.setTyping fires B.on('typing') within 5s", async () => {
    // EXPECTED-FAIL today: `Messaging.setTyping` is a stub that just sleeps
    // for the duration without dispatching the underlying WS frame. This
    // test pins the contract so when the outbound presence path lands the
    // test starts passing without needing a new spec.
    let typingObserved = false;
    B.messaging.on("typing", (ev) => {
      if (ev.userId === userIdA) typingObserved = true;
    });

    await throttledOp("A.setTyping", () => A.messaging.setTyping(convId, 2_000));

    const fired = await waitFor(() => typingObserved, 5_000);
    expect(fired).toBe(true);
  }, 30_000);

  test.skip("A.setViewing fires B.on('viewing') within 5s", async () => {
    // Skipped — `Messaging.setViewing` is a stub today, same gap as
    // setTyping. Wire the presence delegate first, then unskip.
  });

  test.skip("A reads B's message → B.on('read') fires within 5s", async () => {
    // Skipped — read receipts not wired. The inbound `read` slot lives
    // on the same presence delegate as typing/viewing; once that delegate
    // is identified the inbound side becomes free, the outbound `markRead`
    // call still needs wiring.
  });
});

// ─── Send + receive: media ─────────────────────────────────────────────

describe("send + receive: media (skipped — wire-test pending)", () => {
  test.skip("A.sendImage(bytes) surfaces on B.on('message') as ct=1", () => {
    // Skipped — `sendImage` compiles but the bundle's media-upload pipeline
    // needs Blob shim + delegate wiring we haven't exercised end-to-end.
  });

  test.skip("A.sendSnap(bytes) surfaces on B.on('message') as ct=3", () => {
    // Skipped — same gap as sendImage. Snap uses Fidelius E2E for snap
    // bodies; bundle drives that path internally once media upload works.
  });
});

// ─── Isolation under load ──────────────────────────────────────────────

describe("isolation under load", () => {
  test("A and B have distinct sandboxes / WASM realms / Fidelius identities", async () => {
    // Same shape as scripts/test-isolation.ts — different vm.Context
    // references, different moduleEnv references. Should pass today.
    const { getStandaloneChatRealm } = await import("../../src/bundle/chat/standalone/index.ts");
    const sandboxA = await introspectSandbox(A);
    const sandboxB = await introspectSandbox(B);
    expect(sandboxA).not.toBe(sandboxB);

    const realmA = await getStandaloneChatRealm(sandboxA as never);
    const realmB = await getStandaloneChatRealm(sandboxB as never);
    expect(realmA.context).not.toBe(realmB.context);
    expect(realmA.moduleEnv).not.toBe(realmB.moduleEnv);

    // Same-sandbox cache hit — second call returns the same realm refs.
    const realmAagain = await getStandaloneChatRealm(sandboxA as never);
    expect(realmAagain.context).toBe(realmA.context);
    expect(realmAagain.moduleEnv).toBe(realmA.moduleEnv);
  }, 60_000);
});
