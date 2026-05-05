/**
 * STATE-DRIVEN tests — `src/bundle/register/chat.ts`.
 *
 * `chatStore` resolves via `reachModule` to `MOD_CHAT_STORE`'s `.M` export.
 * `chatRpc` resolves via `reach()` from `__SNAPCAP_NI`.
 * `chatWreq` delegates to `getChatWreq(sandbox)`.
 *
 * MockSandbox's `withChatStore()` wires everything needed for chatStore.
 * chatRpc and chatWreq are tested via `withGlobal`.
 */
import { describe, expect, test } from "bun:test";
import { chatRpc, chatStore, chatWreq } from "../../../src/bundle/register/chat.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
} from "../../lib/fixtures/index.ts";

// ─── chatStore ────────────────────────────────────────────────────────────────

describe("bundle/register/chat — chatStore(sandbox)", () => {
  test("returns the mock chat store (has getState, setState, subscribe)", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    const store = chatStore(sandbox);
    expect(typeof store.getState).toBe("function");
    expect(typeof store.setState).toBe("function");
    expect(typeof store.subscribe).toBe("function");
  });

  test("getState() returns the initial chat state", () => {
    const state = chatStateFixture({ user: smallGraphUserSliceFixture() });
    const sandbox = mockSandbox().withChatStore(state).build();

    const live = chatStore(sandbox).getState();
    expect((live as typeof state).user.mutuallyConfirmedFriendIds).toHaveLength(5);
  });

  test("throws when chat store is not wired", () => {
    const sandbox = mockSandbox().build();
    expect(() => chatStore(sandbox)).toThrow();
  });
});

// ─── chatRpc ─────────────────────────────────────────────────────────────────

describe("bundle/register/chat — chatRpc(sandbox)", () => {
  test("returns the RPC client when global is present", () => {
    const fakeRpc = { rpc: { unary: () => {} } };
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_NI", fakeRpc)
      .build();

    expect(chatRpc(sandbox) as unknown).toBe(fakeRpc);
  });

  test("throws 'bundle entity not available' when global is absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => chatRpc(sandbox)).toThrow("chatRpc: bundle entity not available");
  });
});

// ─── chatWreq ─────────────────────────────────────────────────────────────────

describe("bundle/register/chat — chatWreq(sandbox)", () => {
  test("returns the wreq function when withChatStore is wired", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    const wreq = chatWreq(sandbox);
    expect(typeof wreq).toBe("function");
    expect(wreq.m).toBeDefined();
    expect(typeof wreq.m).toBe("object");
  });

  test("MOD_CHAT_STORE is callable on the wreq and returns {M: store}", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    const wreq = chatWreq(sandbox);
    const mod = wreq("94704") as { M: { getState: Function } };
    expect(typeof mod.M.getState).toBe("function");
  });

  test("throws when wreq is not installed", () => {
    const sandbox = mockSandbox().build();
    expect(() => chatWreq(sandbox)).toThrow();
  });
});
