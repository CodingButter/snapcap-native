/**
 * STATE-DRIVEN test — `src/api/auth/auth-state.ts`.
 *
 * The four getters (`getAuthToken`, `getAuthState`, `isAuthenticated`,
 * `hasEverLoggedIn`) all call `authSlice(ctx.sandbox)` which resolves via
 * the chat-bundle registry. We wire a MockSandbox with a live-shaped auth
 * slice to control the values the getters read.
 *
 * `AuthSliceLive` (the runtime shape with reactive fields) is inlined via
 * overrides because the fixture-layer `AuthSlice` type only covers the
 * method surface. The overrides are safe because the runtime slice carries
 * both methods and reactive fields.
 */
import { describe, expect, test } from "bun:test";
import {
  getAuthState,
  getAuthToken,
  hasEverLoggedIn,
  isAuthenticated,
} from "../../../src/api/auth/auth-state.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, authSliceFixture } from "../../lib/fixtures/index.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import type { CookieJarStore } from "../../../src/storage/cookie-store.ts";
import { CookieJar } from "tough-cookie";

// Build a minimal ClientContext backed by a MockSandbox.
// These tests only care about the sandbox auth slice — the cookie jar is
// not exercised. We cast a raw CookieJar to CookieJarStore to satisfy the
// type without the async factory overhead.
function fakeJar(): CookieJarStore {
  return { jar: new CookieJar(), flush: async () => {} } as unknown as CookieJarStore;
}

function makeCtx(authOverrides: Record<string, unknown> = {}): ClientContext {
  const ds = new MemoryDataStore();
  const sandbox = mockSandbox()
    .withChatStore(
      chatStateFixture({
        auth: authSliceFixture(authOverrides as Parameters<typeof authSliceFixture>[0]),
      }),
    )
    .build();
  return { sandbox, jar: fakeJar(), dataStore: ds, userAgent: "Test/1.0" };
}

function makeBundleDownCtx(): ClientContext {
  return { sandbox: mockSandbox().build(), jar: fakeJar(), dataStore: new MemoryDataStore(), userAgent: "" };
}

describe("api/auth/auth-state — getAuthToken", () => {
  test("returns the bearer from authToken.token", () => {
    const ctx = makeCtx({ authToken: { token: "snap_bearer_xyz", lastTokenRefresh: 0 } });
    expect(getAuthToken(ctx)).toBe("snap_bearer_xyz");
  });

  test("returns empty string when authToken.token is empty", () => {
    const ctx = makeCtx({ authToken: { token: "", lastTokenRefresh: undefined } });
    expect(getAuthToken(ctx)).toBe("");
  });
});

describe("api/auth/auth-state — getAuthState", () => {
  test("returns 1 (LoggedIn) when set", () => {
    const ctx = makeCtx({ authState: 1 });
    expect(getAuthState(ctx)).toBe(1);
  });

  test("returns 0 (LoggedOut) when set", () => {
    const ctx = makeCtx({ authState: 0 });
    expect(getAuthState(ctx)).toBe(0);
  });

  test("returns 2 (Processing) when set", () => {
    const ctx = makeCtx({ authState: 2 });
    expect(getAuthState(ctx)).toBe(2);
  });
});

describe("api/auth/auth-state — isAuthenticated", () => {
  test("returns true when authState === 1", () => {
    const ctx = makeCtx({ authState: 1 });
    expect(isAuthenticated(ctx)).toBe(true);
  });

  test("returns false when authState === 0", () => {
    const ctx = makeCtx({ authState: 0 });
    expect(isAuthenticated(ctx)).toBe(false);
  });

  test("returns false when authSlice throws (bundle not yet up)", () => {
    // Wire a sandbox with NO chatStore — authSlice() will throw when it
    // tries to reach __snapcap_chat_p.
    expect(isAuthenticated(makeBundleDownCtx())).toBe(false);
  });
});

describe("api/auth/auth-state — hasEverLoggedIn", () => {
  test("returns true when hasEverLoggedIn is true on the slice", () => {
    const ctx = makeCtx({ hasEverLoggedIn: true });
    expect(hasEverLoggedIn(ctx)).toBe(true);
  });

  test("returns false when hasEverLoggedIn is false on the slice", () => {
    const ctx = makeCtx({ hasEverLoggedIn: false });
    expect(hasEverLoggedIn(ctx)).toBe(false);
  });

  test("returns false when bundle is not up (authSlice throws)", () => {
    expect(hasEverLoggedIn(makeBundleDownCtx())).toBe(false);
  });
});
