/**
 * STATE-DRIVEN tests — `src/shims/webpack-capture.ts`
 *
 * installWebpackCapture(sandbox) hooks webpack chunk arrays on the sandbox
 * window and returns per-sandbox accumulators.
 *
 * The existing multi-instance-isolation.test.ts already covers the
 * cross-Sandbox isolation invariant. This file covers the functional
 * behaviour: factory wrapping, module capture, hint detection, idempotency,
 * and runtime patching.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import { installWebpackCapture } from "../../src/shims/webpack-capture.ts";

function makeSandbox(): Sandbox {
  return new Sandbox({ dataStore: new MemoryDataStore() });
}

describe("shims/webpack-capture — installWebpackCapture", () => {
  test("returns accumulators with empty maps on first install", () => {
    const sb = makeSandbox();
    const { modules, originals, hints } = installWebpackCapture(sb);
    expect(modules.size).toBe(0);
    expect(originals.size).toBe(0);
    expect(hints).toHaveLength(0);
  });

  test("idempotent — second install on same Sandbox returns same maps", () => {
    const sb = makeSandbox();
    const cap1 = installWebpackCapture(sb);
    const cap2 = installWebpackCapture(sb);
    expect(cap1.modules).toBe(cap2.modules);
    expect(cap1.originals).toBe(cap2.originals);
    expect(cap1.hints).toBe(cap2.hints);
  });

  test("captures module exports when chunk is pushed to the array", () => {
    const sb = makeSandbox();
    const { modules } = installWebpackCapture(sb);

    // Simulate the bundle pushing a chunk.
    const w = sb.window as unknown as Record<string, unknown>;
    const arr = w["webpackChunk_N_E"] as Array<unknown>;
    expect(Array.isArray(arr)).toBe(true);

    // Push a synthetic chunk: [[chunkId], { "42": factory }]
    arr.push([
      ["chunk0"],
      {
        "42": (m: { exports: unknown }) => {
          m.exports = { hello: "world" };
        },
      },
    ]);

    // Modules are captured lazily when the factory is called. Simulate
    // require by calling the wrapped factory.
    const wrappedFactory = (arr[0] as Array<unknown>)[1] as Record<string, (m: { exports: unknown }) => void>;
    const mod = { exports: {} };
    wrappedFactory["42"]!(mod);
    expect(modules.has("42")).toBe(true);
    expect(modules.get("42")).toEqual({ hello: "world" });
  });

  test("hints are recorded when exported keys match HINT_PATTERNS", () => {
    const sb = makeSandbox();
    const { hints } = installWebpackCapture(sb);

    const w = sb.window as unknown as Record<string, unknown>;
    const arr = w["webpackChunk_N_E"] as Array<unknown>;

    arr.push([
      ["chunk1"],
      {
        "99": (m: { exports: Record<string, unknown> }) => {
          m.exports = { sendMessage: () => {}, other: 1 };
        },
      },
    ]);

    const chunkModules = (arr[arr.length - 1] as Array<unknown>)[1] as Record<string, (m: { exports: Record<string, unknown> }) => void>;
    const mod = { exports: {} as Record<string, unknown> };
    chunkModules["99"]!(mod);

    expect(hints.some((h) => h.moduleId === "99")).toBe(true);
    expect(hints.find((h) => h.moduleId === "99")?.hint).toContain("send");
  });

  test("originals map contains the unwrapped factory", () => {
    const sb = makeSandbox();
    const { originals } = installWebpackCapture(sb);

    const w = sb.window as unknown as Record<string, unknown>;
    const arr = w["webpackChunk_N_E"] as Array<unknown>;

    let called = false;
    arr.push([
      ["cx"],
      {
        "55": (m: { exports: unknown }) => {
          called = true;
          m.exports = {};
        },
      },
    ]);

    // At this point the factory is wrapped; the original is in originals.
    expect(originals.size).toBe(1);
    const orig = [...originals.values()][0]!;
    expect(typeof orig).toBe("function");
    orig({ exports: {} }, {}, () => {});
    expect(called).toBe(true);
  });

  test("per-Sandbox isolation — writes to sbA do not appear in sbB", () => {
    const sbA = makeSandbox();
    const sbB = makeSandbox();
    const capA = installWebpackCapture(sbA);
    const capB = installWebpackCapture(sbB);

    capA.modules.set("CANARY", { from: "A" });
    expect(capB.modules.has("CANARY")).toBe(false);
  });
});
