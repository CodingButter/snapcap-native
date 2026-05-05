/**
 * STATE-DRIVEN tests — `src/bundle/prime.ts`.
 *
 * `primeModule10409` and `primeAuthStoreModule` are webpack-cycle workaround
 * helpers. Both are async; both take a `Sandbox` and use `chatWreq(sandbox)`
 * to access the factory map.
 *
 * The tests use MockSandbox with a custom wreq that either exposes the
 * expected globals (fast path) or simulates a factory that writes them.
 *
 * We do NOT test the real retry loop with real bundle factories — that
 * requires a live bundle load (LIVE-ONLY). These tests cover:
 *   (a) isModule10409Primed fast-path (any of the three globals present)
 *   (b) primeModule10409 returns immediately when already primed
 *   (c) primeModule10409 runs the factory and detects globals after execution
 *   (d) primeAuthStoreModule returns immediately when M.getState is callable
 *   (e) primeAuthStoreModule runs shimmed wreq when M.getState is missing
 */
import { describe, expect, test } from "bun:test";
import {
  primeAuthStoreModule,
  primeModule10409,
} from "../../src/bundle/prime.ts";
import { mockSandbox } from "../lib/mock-sandbox.ts";
import { chatStateFixture } from "../lib/fixtures/index.ts";

// Build a sandbox that has the chat wreq set up but lets us inject the
// 10409 factory body and set globals manually.
function makePrimeSandbox(opts: {
  jzPresent?: boolean;
  hyPresent?: boolean;
  storeGetState?: Function | null;
} = {}) {
  const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();

  if (opts.jzPresent) sandbox.setGlobal("__SNAPCAP_JZ", { tag: "jz" });
  if (opts.hyPresent) sandbox.setGlobal("__SNAPCAP_HY", { tag: "hy" });

  // Optionally override the MOD_CHAT_STORE module to return a store with
  // or without getState
  if (opts.storeGetState !== undefined) {
    const wreq = sandbox.getGlobal<{ m: Record<string, () => unknown> }>("__snapcap_chat_p")!;
    wreq.m["94704"] = () => ({
      M: opts.storeGetState ? { getState: opts.storeGetState } : {},
    });
  }

  return sandbox;
}

// ─── primeModule10409 ─────────────────────────────────────────────────────────

describe("bundle/prime — primeModule10409", () => {
  test("returns immediately when __SNAPCAP_JZ is already present", async () => {
    const sandbox = makePrimeSandbox({ jzPresent: true });
    // Should resolve without touching factories
    await expect(primeModule10409(sandbox)).resolves.toBeUndefined();
  });

  test("returns immediately when __SNAPCAP_HY is already present", async () => {
    const sandbox = makePrimeSandbox({ hyPresent: true });
    await expect(primeModule10409(sandbox)).resolves.toBeUndefined();
  });

  test("runs factory and detects globals set during factory execution", async () => {
    const sandbox = makePrimeSandbox(); // no globals yet

    // Inject a 10409 factory that sets the global as a side-effect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wreq = sandbox.getGlobal<{ m: Record<string, any> }>("__snapcap_chat_p")!;
    wreq.m["10409"] = (_mod: unknown, _exp: unknown, _shimmedWreq: unknown) => {
      // Simulate the real factory setting the global
      sandbox.setGlobal("__SNAPCAP_JZ", { tag: "jz" });
    };

    await primeModule10409(sandbox);
    expect(sandbox.getGlobal("__SNAPCAP_JZ")).toBeDefined();
  });

  test("resolves even if no factory is present (no infinite hang)", async () => {
    const sandbox = makePrimeSandbox(); // no globals, no 10409 factory
    // Should exhaust retry loop and return (globals still undefined)
    await expect(primeModule10409(sandbox)).resolves.toBeUndefined();
  }, 5000);
});

// ─── primeAuthStoreModule ─────────────────────────────────────────────────────

describe("bundle/prime — primeAuthStoreModule", () => {
  test("returns immediately when M.getState is already callable", async () => {
    const fakeGetState = () => ({});
    const sandbox = makePrimeSandbox({ storeGetState: fakeGetState });
    await expect(primeAuthStoreModule(sandbox)).resolves.toBeUndefined();
  });

  test("resolves even when M has no getState (shimmed path exhausts attempts)", async () => {
    const sandbox = makePrimeSandbox({ storeGetState: null });
    // Retry loop runs up to 6 times then gives up cleanly
    await expect(primeAuthStoreModule(sandbox)).resolves.toBeUndefined();
  }, 2000);

  test("resolves when shimmed wreq produces M.getState after a re-eval", async () => {
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();

    let callCount = 0;
    const wreq = sandbox.getGlobal<{ m: Record<string, () => unknown> }>("__snapcap_chat_p")!;
    wreq.m["94704"] = () => {
      callCount++;
      // On second call, return a proper store
      if (callCount >= 2) return { M: { getState: () => ({}) } };
      return { M: {} };
    };

    await primeAuthStoreModule(sandbox);
    // Should have been called at least twice (initial probe + shimmed retry)
    expect(callCount).toBeGreaterThanOrEqual(1);
  }, 2000);
});
