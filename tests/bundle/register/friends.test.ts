/**
 * STATE-DRIVEN tests — `src/bundle/register/friends.ts`.
 *
 * `friendActionClient` and `friendRequestsClient` both delegate to `reach()`.
 * Tests: (a) return the sentinel when the global is present,
 *        (b) throw the right error when absent.
 */
import { describe, expect, test } from "bun:test";
import {
  friendActionClient,
  friendRequestsClient,
} from "../../../src/bundle/register/friends.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";

describe("bundle/register/friends — friendActionClient(sandbox)", () => {
  test("returns the jz FriendAction instance when global is present", () => {
    const fakeJz = { AddFriends: () => Promise.resolve() };
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_JZ", fakeJz)
      .build();

    expect(friendActionClient(sandbox) as unknown).toBe(fakeJz);
  });

  test("throws 'bundle entity not available' when global is absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => friendActionClient(sandbox)).toThrow(
      "friendActionClient: bundle entity not available",
    );
  });

  test("error message includes the global key it searched for", () => {
    const sandbox = mockSandbox().build();
    expect(() => friendActionClient(sandbox)).toThrow("__SNAPCAP_JZ");
  });
});

describe("bundle/register/friends — friendRequestsClient(sandbox)", () => {
  test("returns the FriendRequests N instance when global is present", () => {
    const fakeN = { Process: () => Promise.resolve(), IncomingFriendSync: () => Promise.resolve() };
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_FRIEND_REQUESTS", fakeN)
      .build();

    expect(friendRequestsClient(sandbox) as unknown).toBe(fakeN);
  });

  test("throws 'bundle entity not available' when global is absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => friendRequestsClient(sandbox)).toThrow(
      "friendRequestsClient: bundle entity not available",
    );
  });

  test("error message includes the global key it searched for", () => {
    const sandbox = mockSandbox().build();
    expect(() => friendRequestsClient(sandbox)).toThrow("__SNAPCAP_FRIEND_REQUESTS");
  });
});
