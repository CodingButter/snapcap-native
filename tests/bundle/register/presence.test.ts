/**
 * STATE-DRIVEN tests — `src/bundle/register/presence.ts`.
 *
 * `presenceSlice` reads `chatStore(sandbox).getState().presence`.
 * `presenceStateEnum` resolves via `reachModule` to MOD_PRESENCE_STATE_ENUM.
 */
import { describe, expect, test } from "bun:test";
import {
  presenceSlice,
  presenceStateEnum,
} from "../../../src/bundle/register/presence.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  activePresenceSliceFixture,
  awayPresenceSliceFixture,
  chatStateFixture,
  presenceSliceFixture,
} from "../../lib/fixtures/index.ts";
import { MOD_PRESENCE_STATE_ENUM } from "../../../src/bundle/register/module-ids.ts";

// ─── presenceSlice ────────────────────────────────────────────────────────────

describe("bundle/register/presence — presenceSlice(sandbox)", () => {
  test("returns default presence slice (no session, awayState=Present)", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    const slice = presenceSlice(sandbox);
    expect(slice.presenceSession).toBeUndefined();
    expect(slice.awayState).toBe("Present");
    expect(typeof slice.broadcastTypingActivity).toBe("function");
  });

  test("returns active presence slice when fixture provides a session", () => {
    const convId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fix = activePresenceSliceFixture(convId);
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ presence: fix }))
      .build();

    const slice = presenceSlice(sandbox);
    expect(slice.presenceSession).toBeDefined();
    expect(slice.awayState).toBe("Present");
  });

  test("returns away presence slice when fixture sets awayState", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ presence: awayPresenceSliceFixture() }))
      .build();

    const slice = presenceSlice(sandbox);
    expect(slice.awayState).toBe("Away");
  });

  test("throws when no chat store is wired", () => {
    const sandbox = mockSandbox().build();
    expect(() => presenceSlice(sandbox)).toThrow();
  });
});

// ─── presenceStateEnum ────────────────────────────────────────────────────────

describe("bundle/register/presence — presenceStateEnum(sandbox)", () => {
  test("returns the O enum from the stubbed module", () => {
    const fakeO = { Present: 0, Away: 1, AwaitingReactivate: 2 };
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    // Inject the module into the wreq factory map
    const wreq = sandbox.getGlobal<{ m: Record<string, () => unknown> }>("__snapcap_chat_p")!;
    wreq.m[MOD_PRESENCE_STATE_ENUM] = () => ({ O: fakeO });

    const enumResult = presenceStateEnum(sandbox);
    expect(enumResult.Present).toBe(0);
    expect(enumResult.Away).toBe(1);
    expect(enumResult.AwaitingReactivate).toBe(2);
  });

  test("throws when MOD_PRESENCE_STATE_ENUM module is not in wreq", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    expect(() => presenceStateEnum(sandbox)).toThrow(
      `presenceStateEnum: chat wreq lookup of module ${MOD_PRESENCE_STATE_ENUM} failed`,
    );
  });
});
