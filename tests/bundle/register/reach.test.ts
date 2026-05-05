/**
 * PURE tests — `src/bundle/register/reach.ts`.
 *
 * `reach` and `reachModule` are the two resolution helpers that every
 * domain getter file calls. Both have clearly-defined success and failure
 * paths: return the entity, throw a friendly error when it's missing.
 *
 * No real Sandbox needed — MockSandbox satisfies the `getGlobal` contract
 * that `reach` uses, and a fake wreq satisfies `reachModule` via the
 * __snapcap_chat_p global.
 */
import { describe, expect, test } from "bun:test";
import { reach, reachModule } from "../../../src/bundle/register/reach.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture } from "../../lib/fixtures/index.ts";

// ─── reach ───────────────────────────────────────────────────────────────────

describe("bundle/register/reach — reach()", () => {
  test("returns the value when globalKey is present on the sandbox", () => {
    const sentinel = { tag: "loginCtorSentinel" };
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_LOGIN_CLIENT_IMPL", sentinel)
      .build();

    const result = reach(sandbox, "__SNAPCAP_LOGIN_CLIENT_IMPL", "loginClient");
    expect(result).toBe(sentinel);
  });

  test("throws 'bundle entity not available' when key is absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => reach(sandbox, "__SNAPCAP_MISSING_KEY", "myGetter")).toThrow(
      "myGetter: bundle entity not available",
    );
  });

  test("throws 'bundle entity not available' and mentions the globalKey in the message", () => {
    const sandbox = mockSandbox().build();
    expect(() => reach(sandbox, "__SNAPCAP_FOO", "fooGetter")).toThrow(
      "globalThis.__SNAPCAP_FOO",
    );
  });

  test("throws 'not yet mapped' when globalKey is undefined (TODO getter)", () => {
    const sandbox = mockSandbox().build();
    expect(() => reach(sandbox, undefined, "storyManager")).toThrow(
      "storyManager: bundle export not yet mapped",
    );
  });

  test("works with any truthy value — number, string, class instance", () => {
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_NUM", 42)
      .withGlobal("__SNAPCAP_STR", "hello")
      .build();

    expect(reach<number>(sandbox, "__SNAPCAP_NUM", "num")).toBe(42);
    expect(reach<string>(sandbox, "__SNAPCAP_STR", "str")).toBe("hello");
  });
});

// ─── reachModule ─────────────────────────────────────────────────────────────

describe("bundle/register/reach — reachModule()", () => {
  test("returns the module export object for a registered module", () => {
    const fakeModule = { M: { getState: () => ({}) } };
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    // MOD_CHAT_STORE = "94704" is registered by withChatStore()
    // reachModule uses getChatWreq which reads __snapcap_chat_p
    const result = reachModule<{ M: unknown }>(sandbox, "94704", "chatStore");
    expect(result).toHaveProperty("M");
    expect(typeof (result as { M: { getState: Function } }).M.getState).toBe("function");
  });

  test("throws a wrapped error when the module id is not found in wreq", () => {
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture())
      .build();

    // "99999" is not registered in the mock wreq
    expect(() => reachModule(sandbox, "99999", "unknownModule")).toThrow(
      "unknownModule: chat wreq lookup of module 99999 failed",
    );
  });

  test("throws when no chat wreq is installed at all", () => {
    const sandbox = mockSandbox().build();
    // No withChatStore → no __snapcap_chat_p → getChatWreq throws
    expect(() => reachModule(sandbox, "94704", "chatStore")).toThrow();
  });
});
