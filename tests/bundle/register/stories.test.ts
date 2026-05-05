/**
 * STATE-DRIVEN tests — `src/bundle/register/stories.ts`.
 *
 * Both `userInfoClient` and `storyManager` are TODO getters whose patch-key
 * constants are `undefined`. They unconditionally throw
 * "bundle export not yet mapped" via `reach()`.
 *
 * Tests verify: (a) they ALWAYS throw with the right message shape,
 *               (b) the error name includes "not yet mapped".
 */
import { describe, expect, test } from "bun:test";
import {
  storyManager,
  userInfoClient,
} from "../../../src/bundle/register/stories.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture } from "../../lib/fixtures/index.ts";

describe("bundle/register/stories — userInfoClient(sandbox)", () => {
  test("always throws 'bundle export not yet mapped'", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    expect(() => userInfoClient(sandbox)).toThrow("bundle export not yet mapped");
  });

  test("error message includes the getter name", () => {
    const sandbox = mockSandbox().build();
    expect(() => userInfoClient(sandbox)).toThrow("userInfoClient");
  });
});

describe("bundle/register/stories — storyManager(sandbox)", () => {
  test("always throws 'bundle export not yet mapped'", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    expect(() => storyManager(sandbox)).toThrow("bundle export not yet mapped");
  });

  test("error message includes the getter name", () => {
    const sandbox = mockSandbox().build();
    expect(() => storyManager(sandbox)).toThrow("storyManager");
  });
});
