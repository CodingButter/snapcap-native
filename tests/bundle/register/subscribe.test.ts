/**
 * STATE-DRIVEN tests — `src/bundle/register/subscribe.ts`.
 *
 * `subscribeUserSlice` wraps chatStore.subscribe with a projection +
 * equality guard. Tests cover:
 *   (a) listener NOT fired on initial subscribe (no-replay semantics)
 *   (b) listener fires when projected value changes
 *   (c) listener skips when projected value is equal
 *   (d) unsubscribe is idempotent and stops further callbacks
 *   (e) consumer errors are swallowed — subscription survives
 *   (f) graceful no-op when no chat store is wired
 */
import { describe, expect, test } from "bun:test";
import { subscribeUserSlice } from "../../../src/bundle/register/subscribe.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  chatStateFixture,
  smallGraphUserSliceFixture,
  userSliceFixture,
} from "../../lib/fixtures/index.ts";
import type { UserSlice } from "../../../src/bundle/types/index.ts";

describe("bundle/register/subscribe — subscribeUserSlice", () => {
  test("does NOT fire callback on initial subscribe (no-replay)", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    const calls: unknown[] = [];
    subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      (curr) => calls.push(curr),
    );

    expect(calls).toHaveLength(0);
  });

  test("fires callback when projected value changes", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    const calls: number[] = [];
    subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      (curr) => calls.push(curr),
    );

    const store = sandbox._chatStore!;
    store.setState({ user: smallGraphUserSliceFixture() } as Partial<typeof chatStateFixture>);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(5);
  });

  test("does NOT fire when equality guard says equal", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: smallGraphUserSliceFixture() }))
      .build();

    const calls: unknown[] = [];
    subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b, // always-equal for same length
      (curr) => calls.push(curr),
    );

    // Same slice, same length — equality holds
    const store = sandbox._chatStore!;
    store.setState({ user: smallGraphUserSliceFixture() } as Partial<typeof chatStateFixture>);

    expect(calls).toHaveLength(0);
  });

  test("unsubscribe stops further callbacks", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    const calls: number[] = [];
    const unsub = subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      (curr) => calls.push(curr as number),
    );

    unsub();

    const store = sandbox._chatStore!;
    store.setState({ user: smallGraphUserSliceFixture() } as Partial<typeof chatStateFixture>);

    expect(calls).toHaveLength(0);
  });

  test("unsubscribe is idempotent (calling twice doesn't throw)", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    const unsub = subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      () => {},
    );

    expect(() => { unsub(); unsub(); }).not.toThrow();
  });

  test("callback receives correct (curr, prev, fullState) args", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    const seen: Array<{ curr: number; prev: number }> = [];
    subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      (curr, prev) => seen.push({ curr: curr as number, prev: prev as number }),
    );

    const store = sandbox._chatStore!;
    store.setState({ user: smallGraphUserSliceFixture() } as Partial<typeof chatStateFixture>);

    expect(seen[0]?.prev).toBe(0);
    expect(seen[0]?.curr).toBe(5);
  });

  test("consumer errors inside callback are swallowed — subscription survives", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ user: userSliceFixture() }))
      .build();

    let callCount = 0;
    subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      () => {
        callCount++;
        throw new Error("consumer error — should be swallowed");
      },
    );

    const store = sandbox._chatStore!;
    // First state change — fires, consumer throws, subscription survives
    store.setState({ user: smallGraphUserSliceFixture() } as Partial<typeof chatStateFixture>);
    // Second state change — should still fire despite earlier throw
    store.setState({ user: userSliceFixture() } as Partial<typeof chatStateFixture>);

    expect(callCount).toBe(2);
  });

  test("returns a no-op unsub when chat store is not wired", () => {
    const sandbox = mockSandbox().build(); // no withChatStore

    const unsub = subscribeUserSlice(
      sandbox,
      (u) => u.mutuallyConfirmedFriendIds.length,
      (a, b) => a === b,
      () => {},
    );

    // Should not throw — just a no-op unsub
    expect(() => unsub()).not.toThrow();
  });
});
