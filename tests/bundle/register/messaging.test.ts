/**
 * STATE-DRIVEN tests — `src/bundle/register/messaging.ts`.
 *
 * `messagingSlice` reads `chatStore(sandbox).getState().messaging`.
 * `messagingSends` resolves via `reachModule` to MOD_SENDS.
 */
import { describe, expect, test } from "bun:test";
import {
  messagingSends,
  messagingSlice,
} from "../../../src/bundle/register/messaging.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  messagingSliceFixture,
  manyConvMessagingSliceFixture,
} from "../../lib/fixtures/index.ts";
import { MOD_SENDS } from "../../../src/bundle/register/module-ids.ts";

// ─── messagingSlice ───────────────────────────────────────────────────────────

describe("bundle/register/messaging — messagingSlice(sandbox)", () => {
  test("returns the messaging slice (empty) from chat state", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    const slice = messagingSlice(sandbox);
    expect(slice.conversations).toEqual({});
    expect(typeof slice.fetchConversation).toBe("function");
  });

  test("returns populated messaging slice when chat store has conversations", () => {
    const SELF = "11111111-1111-1111-1111-111111111111";
    const fix = manyConvMessagingSliceFixture(SELF, 5);
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ messaging: fix }))
      .build();

    const slice = messagingSlice(sandbox);
    expect(Object.keys(slice.conversations)).toHaveLength(5);
  });

  test("throws when no chat store is wired", () => {
    const sandbox = mockSandbox().build();
    expect(() => messagingSlice(sandbox)).toThrow();
  });
});

// ─── messagingSends ───────────────────────────────────────────────────────────

describe("bundle/register/messaging — messagingSends(sandbox)", () => {
  test("returns the sends module when MOD_SENDS is stubbed in wreq", () => {
    const fakeSends = { sendText: () => {}, sendImage: () => {} };
    // Build a custom wreq that handles MOD_SENDS
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    // Inject a fake module into the wreq's factory map
    const wreq = sandbox.getGlobal<{ m: Record<string, () => unknown> }>("__snapcap_chat_p")!;
    wreq.m[MOD_SENDS] = () => fakeSends;

    const result = messagingSends(sandbox);
    expect(result as unknown).toBe(fakeSends);
  });

  test("throws 'chat wreq lookup … failed' when MOD_SENDS is not in wreq", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    // MOD_SENDS is not registered by default in withChatStore
    expect(() => messagingSends(sandbox)).toThrow(
      `messagingSends: chat wreq lookup of module ${MOD_SENDS} failed`,
    );
  });
});
