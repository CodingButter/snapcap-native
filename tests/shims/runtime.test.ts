/**
 * STATE-DRIVEN tests — `src/shims/runtime.ts`
 *
 * runtime.ts re-exports { Sandbox, InstallShimOpts } from sandbox.ts.
 * It is a thin re-export barrel — the only behavioural surface is the
 * Sandbox class itself, which is tested in sandbox.test.ts.
 *
 * These tests exist for completeness: they verify that the named exports
 * from runtime.ts are the same objects exported from sandbox.ts, so a
 * consumer importing from either path gets the same class.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox as SandboxFromRuntime } from "../../src/shims/runtime.ts";
import { Sandbox as SandboxFromSandbox } from "../../src/shims/sandbox.ts";

describe("shims/runtime — re-exports", () => {
  test("Sandbox exported from runtime.ts is the same class as from sandbox.ts", () => {
    expect(SandboxFromRuntime).toBe(SandboxFromSandbox);
  });

  test("constructing via the runtime export works identically", () => {
    const sb = new SandboxFromRuntime();
    expect(sb.window).toBeDefined();
    expect(sb.context).toBeDefined();
  });
});
