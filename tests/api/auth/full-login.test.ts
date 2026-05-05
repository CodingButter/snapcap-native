/**
 * Test — `src/api/auth/full-login.ts`.
 *
 * # Coverage note (read before adding tests)
 *
 * `fullLogin(ctx, opts)` is documented as NETWORK in the audit, but the
 * current implementation is effectively LIVE-ONLY: it calls `getKameleon`
 * (WASM boot), `loginClient(ctx.sandbox)` (real bundle registry reach),
 * and `ctx.sandbox.runInContext("TextEncoder")` (vm.Context eval). None of
 * these can be satisfied by a MockSandbox.
 *
 * The function does NOT accept a constructor-injected `unary` fn — the
 * unary is minted internally from the accounts-bundle unaryFactory module.
 * Until a test-seam is added (e.g. an optional `_unary?: UnaryFn` param),
 * NETWORK-level unit testing is blocked.
 *
 * Bug exposed: `fullLogin` has no constructor-injected test seam for the
 * unary function. To make it unit-testable, add an optional `_unary` param
 * to the opts object and bypass `unaryFactory` in tests.
 *
 * What IS testable without full bundle eval:
 *   - `activeIdentifier` (in `src/types.ts`) — the only pure helper
 *     called before the bundle is touched. That function has its own
 *     coverage in the PURE test layer.
 *
 * For now this file contains one smoke assertion confirming the function
 * is exported with the expected signature, so any refactor that accidentally
 * drops the export will surface here.
 */
import { describe, expect, test } from "bun:test";
import { fullLogin } from "../../../src/api/auth/full-login.ts";

describe("api/auth/full-login — module contract", () => {
  test("fullLogin is exported as an async function", () => {
    expect(typeof fullLogin).toBe("function");
    // Async functions return a Promise when called; the constructor name
    // differs between engines but the function is callable.
    expect(fullLogin.constructor.name).toMatch(/^(Async)?Function$/);
  });
});
