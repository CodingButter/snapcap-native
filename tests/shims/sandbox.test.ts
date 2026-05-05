/**
 * STATE-DRIVEN tests — `src/shims/sandbox.ts`
 *
 * Sandbox constructs an isolated vm.Context with happy-dom globals.
 * Tests cover: construction, getGlobal/setGlobal, runInContext (basic),
 * toVmU8, window/document/context accessors, throttleGate no-op default,
 * and webpackCapture lifecycle. runInContext with real bundle eval is
 * LIVE-ONLY and not tested here.
 *
 * Already covered by multi-instance-isolation.test.ts:
 *   - Two Sandboxes own disjoint contexts/windows.
 *   - webpack-capture maps are per-Sandbox.
 *   - Cookie containers are per-Sandbox.
 * Those tests are not duplicated here.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

describe("shims/sandbox — construction", () => {
  test("constructs without throwing (no dataStore)", () => {
    expect(() => new Sandbox()).not.toThrow();
  });

  test("constructs with MemoryDataStore without throwing", () => {
    expect(() => new Sandbox({ dataStore: new MemoryDataStore() })).not.toThrow();
  });

  test("window is defined and is not the Node global", () => {
    const sb = new Sandbox();
    expect(sb.window).toBeDefined();
    expect(sb.window).not.toBe(globalThis);
  });

  test("document is defined on the sandbox", () => {
    const sb = new Sandbox();
    expect(sb.document).toBeDefined();
  });

  test("context is a vm.Context (separate from global)", () => {
    const sb = new Sandbox();
    expect(sb.context).toBeDefined();
    expect(sb.context).not.toBe(globalThis);
  });

  test("two Sandboxes have distinct contexts", () => {
    const sbA = new Sandbox();
    const sbB = new Sandbox();
    expect(sbA.context).not.toBe(sbB.context);
  });
});

describe("shims/sandbox — getGlobal / setGlobal", () => {
  test("setGlobal then getGlobal round-trips a value", () => {
    const sb = new Sandbox();
    sb.setGlobal("__TEST_VAL", { foo: 42 });
    expect(sb.getGlobal<{ foo: number }>("__TEST_VAL")).toEqual({ foo: 42 });
  });

  test("getGlobal returns undefined for absent key", () => {
    const sb = new Sandbox();
    expect(sb.getGlobal("__ABSENT")).toBeUndefined();
  });

  test("getGlobal for a well-known browser global returns a value", () => {
    const sb = new Sandbox();
    const val = sb.getGlobal("document");
    expect(val).toBeDefined();
  });
});

describe("shims/sandbox — runInContext", () => {
  test("evaluates a simple expression and returns the result", () => {
    const sb = new Sandbox();
    const result = sb.runInContext("1 + 2", "test-expr");
    expect(result).toBe(3);
  });

  test("variables set via runInContext are visible via getGlobal", () => {
    const sb = new Sandbox();
    sb.runInContext("globalThis.__MY_VAR = 99", "set-var");
    expect(sb.getGlobal<number>("__MY_VAR")).toBe(99);
  });

  test("Promise constructor inside context is the vm-realm one", () => {
    const sb = new Sandbox();
    const VmPromise = sb.runInContext("Promise");
    // Must NOT be the host realm Promise (they differ across vm contexts).
    expect(VmPromise).not.toBe(Promise);
    expect(typeof VmPromise).toBe("function");
  });
});

describe("shims/sandbox — toVmU8", () => {
  test("converts host Uint8Array to a sandbox-realm Uint8Array", () => {
    const sb = new Sandbox();
    const host = new Uint8Array([10, 20, 30]);
    const vm = sb.toVmU8(host);
    expect(vm).toBeDefined();
    // Must have the same byte content.
    expect(Array.from(vm)).toEqual([10, 20, 30]);
  });

  test("vm Uint8Array is instanceof the sandbox-realm Uint8Array constructor", () => {
    const sb = new Sandbox();
    const VmU8 = sb.runInContext("Uint8Array") as Uint8ArrayConstructor;
    const host = new Uint8Array([1, 2]);
    const vm = sb.toVmU8(host);
    expect(vm instanceof VmU8).toBe(true);
  });
});

describe("shims/sandbox — throttleGate default", () => {
  test("throttleGate resolves immediately with no throttle config", async () => {
    const sb = new Sandbox();
    // Default sandbox has no throttle configured — gate should resolve instantly.
    const start = Date.now();
    await sb.throttleGate("https://snap.com/test");
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("shims/sandbox — webpackCapture", () => {
  test("webpackCapture is undefined before installWebpackCapture", () => {
    const sb = new Sandbox();
    expect(sb.webpackCapture).toBeUndefined();
  });
});

describe("shims/sandbox — hdWindow", () => {
  test("hdWindow is the happy-dom Window object", () => {
    const sb = new Sandbox();
    expect(sb.hdWindow).toBeDefined();
    // happy-dom Window has a `document` property.
    expect((sb.hdWindow as { document?: unknown }).document).toBeDefined();
  });
});
