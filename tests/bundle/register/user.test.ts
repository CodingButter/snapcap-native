/**
 * STATE-DRIVEN tests — `src/bundle/register/user.ts`.
 *
 * `userSlice` reads `chatStore(sandbox).getState().user`.
 * `userSliceFrom` is a pure projection thunk.
 *
 * Both are covered with MockSandbox + slice fixtures; no bundle eval needed.
 */
import { describe, expect, test } from "bun:test";
import { userSlice, userSliceFrom } from "../../../src/bundle/register/user.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";

describe("bundle/register/user — userSlice(sandbox)", () => {
  test("returns the user slice from chat state (empty)", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    const slice = userSlice(sandbox);
    expect(slice.mutuallyConfirmedFriendIds).toEqual([]);
    expect(slice.outgoingFriendRequestIds).toEqual([]);
  });

  test("returns the user slice from chat state (populated)", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: smallGraphUserSliceFixture() }))
      .build();

    const slice = userSlice(sandbox);
    expect(slice.mutuallyConfirmedFriendIds).toHaveLength(5);
    expect(slice.outgoingFriendRequestIds).toHaveLength(2);
    expect(slice.incomingFriendRequests.size).toBe(1);
  });

  test("throws when no chat store is wired", () => {
    const sandbox = mockSandbox().build();
    expect(() => userSlice(sandbox)).toThrow();
  });
});

describe("bundle/register/user — userSliceFrom(state)", () => {
  test("projects user slice from a ChatState snapshot", () => {
    const userFix = smallGraphUserSliceFixture();
    const state = chatStateFixture({ user: userFix });
    const result = userSliceFrom(state);
    expect(result).toBe(userFix);
  });

  test("projects user slice from an empty ChatState", () => {
    const state = chatStateFixture();
    const result = userSliceFrom(state);
    expect(result.mutuallyConfirmedFriendIds).toEqual([]);
  });

  test("override — publicUsers cache survives projection", () => {
    const slice = userSliceFixture({
      publicUsers: new Map([["aaa", { username: "alice" }]]),
    });
    const state = chatStateFixture({ user: slice });
    const projected = userSliceFrom(state);
    expect(projected.publicUsers?.get("aaa")?.username).toBe("alice");
  });
});
