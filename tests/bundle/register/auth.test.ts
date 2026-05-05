/**
 * STATE-DRIVEN tests — `src/bundle/register/auth.ts`.
 *
 * `loginClient` resolves via `reach()` from a `__SNAPCAP_LOGIN_CLIENT_IMPL`
 * global. `authSlice` reads `chatStore(sandbox).getState().auth`.
 */
import { describe, expect, test } from "bun:test";
import { authSlice, loginClient } from "../../../src/bundle/register/auth.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import {
  authSliceFixture,
  chatStateFixture,
  midRefreshAuthFixture,
} from "../../lib/fixtures/index.ts";

// ─── loginClient ─────────────────────────────────────────────────────────────

describe("bundle/register/auth — loginClient(sandbox)", () => {
  test("returns the login client ctor when global is present", () => {
    const FakeLoginCtor = class {};
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_LOGIN_CLIENT_IMPL", FakeLoginCtor)
      .build();

    const result = loginClient(sandbox);
    expect(result as unknown).toBe(FakeLoginCtor);
  });

  test("throws 'bundle entity not available' when global is absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => loginClient(sandbox)).toThrow(
      "loginClient: bundle entity not available",
    );
  });
});

// ─── authSlice ────────────────────────────────────────────────────────────────

describe("bundle/register/auth — authSlice(sandbox)", () => {
  test("returns the auth slice from chat state", () => {
    const fix = authSliceFixture({ userId: "abc-123" } as Parameters<typeof authSliceFixture>[0]);
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ auth: fix }))
      .build();

    const slice = authSlice(sandbox);
    expect(typeof slice.initialize).toBe("function");
    expect(typeof slice.logout).toBe("function");
  });

  test("returns mid-refresh auth slice shape when populated that way", () => {
    const fix = midRefreshAuthFixture(0, { userId: "mid-refresh-user" });
    const sandbox = mockSandbox()
      .withChatStore(chatStateFixture({ auth: fix }))
      .build();

    const slice = authSlice(sandbox);
    expect((slice as typeof fix).status).toBe("mid-refresh");
    expect((slice as typeof fix).userId).toBe("mid-refresh-user");
  });

  test("throws when no chat store is wired", () => {
    const sandbox = mockSandbox().build();
    expect(() => authSlice(sandbox)).toThrow();
  });
});
