/**
 * Fixture builders for the chat-bundle `state.auth` slice.
 *
 * These return PLAIN OBJECTS that satisfy {@link AuthSlice} structurally,
 * so consumer code that calls `authSlice(sandbox).userId` (or invokes the
 * thunks) sees a controlled shape per test. Every export is a function
 * returning a fresh object — never a module-scope const — so tests that
 * mutate the slice in-place don't bleed into siblings.
 *
 * Pair with {@link mockSandbox} from `../mock-sandbox.ts`.
 */
import type { AuthSlice } from "../../../src/bundle/types/index.ts";

/**
 * Extra fields tests sometimes set on the auth slice that aren't in the
 * narrow `AuthSlice` interface. The bundle slice carries more state at
 * runtime; the SDK only types what it currently reads. Tests can pass
 * `userId` (etc.) via overrides.
 */
type AuthSliceExtras = {
  /** Hyphenated UUID of the signed-in user. */
  userId?: string;
  /** Bearer token; tests rarely care about the actual value. */
  bearer?: string;
  /** Bundle-side phase marker — 'signed-in' / 'signed-out' / 'mid-refresh'. */
  status?: "signed-in" | "signed-out" | "mid-refresh";
};

/**
 * Default no-op auth slice — every thunk resolves to `undefined` immediately.
 * Use this as a baseline; overrides win via spread.
 *
 * @param overrides - shape to merge onto the default; both core
 *   {@link AuthSlice} fields and the extra runtime fields are accepted.
 * @returns A fresh auth slice object.
 *
 * @example
 * ```ts
 * const slice = authSliceFixture({ userId: "abc-...-def" });
 * ```
 */
export function authSliceFixture(
  overrides: Partial<AuthSlice & AuthSliceExtras> = {},
): AuthSlice & AuthSliceExtras {
  return {
    initialize: async () => {},
    logout: async () => {},
    refreshToken: async () => {},
    fetchToken: async () => undefined,
    ...overrides,
  };
}

/**
 * Signed-out variant — thunks throw if invoked, so accidental usage in a
 * "logged out" test surfaces loudly. The `userId` is empty.
 *
 * @param overrides - shape to merge.
 */
export function signedOutAuthFixture(
  overrides: Partial<AuthSlice & AuthSliceExtras> = {},
): AuthSlice & AuthSliceExtras {
  return authSliceFixture({
    status: "signed-out",
    userId: "",
    refreshToken: async () => {
      throw new Error("auth-fixture[signed-out]: refreshToken called");
    },
    ...overrides,
  });
}

/**
 * Mid-refresh variant — `refreshToken` resolves after a delay. Use to test
 * code that races bearer-rotation (`mintAndInitialize` retry path, etc.).
 *
 * @param delayMs - artificial delay before the refresh resolves.
 * @param overrides - shape to merge.
 */
export function midRefreshAuthFixture(
  delayMs = 100,
  overrides: Partial<AuthSlice & AuthSliceExtras> = {},
): AuthSlice & AuthSliceExtras {
  return authSliceFixture({
    status: "mid-refresh",
    userId: overrides.userId ?? "11111111-1111-1111-1111-111111111111",
    refreshToken: async () => new Promise((resolve) => setTimeout(resolve, delayMs)),
    ...overrides,
  });
}
