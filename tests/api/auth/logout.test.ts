/**
 * STATE-DRIVEN test — `src/api/auth/logout.ts`.
 *
 * `logout(ctx, force?)` calls `authSlice(ctx.sandbox).logout(force)`. We
 * verify:
 *   - `logout` is called on the slice (not silently dropped).
 *   - The `force` flag is forwarded correctly.
 *   - Without `force`, the call still resolves (undefined → ok).
 */
import { describe, expect, test } from "bun:test";
import { logout } from "../../../src/api/auth/logout.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, authSliceFixture } from "../../lib/fixtures/index.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import type { CookieJarStore } from "../../../src/storage/cookie-store.ts";
import { CookieJar } from "tough-cookie";

function fakeJar(): CookieJarStore {
  return { jar: new CookieJar(), flush: async () => {} } as unknown as CookieJarStore;
}

function makeCtx(logoutImpl: (force?: boolean) => Promise<void>): ClientContext {
  const ds = new MemoryDataStore();
  const sandbox = mockSandbox()
    .withChatStore(
      chatStateFixture({
        auth: authSliceFixture({ logout: logoutImpl }),
      }),
    )
    .build();
  return { sandbox, jar: fakeJar(), dataStore: ds, userAgent: "" };
}

describe("api/auth/logout — logout", () => {
  test("calls authSlice.logout with no argument when force is omitted", async () => {
    const calls: Array<boolean | undefined> = [];
    const ctx = makeCtx(async (f) => { calls.push(f); });

    await logout(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
  });

  test("forwards force=true to authSlice.logout", async () => {
    const calls: Array<boolean | undefined> = [];
    const ctx = makeCtx(async (f) => { calls.push(f); });

    await logout(ctx, true);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(true);
  });

  test("forwards force=false to authSlice.logout", async () => {
    const calls: Array<boolean | undefined> = [];
    const ctx = makeCtx(async (f) => { calls.push(f); });

    await logout(ctx, false);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(false);
  });

  test("does not swallow rejection from authSlice.logout", async () => {
    const ctx = makeCtx(async () => { throw new Error("logout rejected"); });

    await expect(logout(ctx)).rejects.toThrow("logout rejected");
  });
});
