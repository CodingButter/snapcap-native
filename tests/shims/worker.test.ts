/**
 * STATE-DRIVEN tests — `src/shims/worker.ts`
 *
 * installWorkerShim installs a no-op Worker stub on the sandbox realm.
 * Tests verify: the stub is installed, is idempotent, satisfies the
 * Worker interface contract (no throw on new Worker / postMessage /
 * addEventListener / terminate), and that two Sandboxes get independent
 * Worker globals (no shared class reference).
 *
 * FakeWorker (the full synchronous in-process variant) is not exercised
 * here because the current installWorkerShim intentionally uses a no-op
 * stub — loading the worker chunk would conflict with the main-thread
 * WASM module. See worker.ts file header for the full explanation.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import { installWorkerShim } from "../../src/shims/worker.ts";

function makeSandbox(): Sandbox {
  return new Sandbox({ dataStore: new MemoryDataStore() });
}

describe("shims/worker — installWorkerShim", () => {
  test("Worker global is defined after install", () => {
    const sb = makeSandbox();
    installWorkerShim(sb, { bundleDir: "vendor/snap-bundle" });
    const Worker = sb.getGlobal("Worker");
    expect(Worker).toBeDefined();
    expect(typeof Worker).toBe("function");
  });

  test("new Worker(...) does not throw", () => {
    const sb = makeSandbox();
    installWorkerShim(sb, { bundleDir: "vendor/snap-bundle" });
    const Worker = sb.getGlobal("Worker") as new (url: string) => {
      postMessage(d: unknown): void;
      addEventListener(t: string, h: unknown): void;
      terminate(): void;
      onmessage: null;
    };
    expect(() => new Worker("https://fake.com/worker.js")).not.toThrow();
  });

  test("stub postMessage / addEventListener / terminate are no-ops (no throw)", () => {
    const sb = makeSandbox();
    installWorkerShim(sb, { bundleDir: "vendor/snap-bundle" });
    const Worker = sb.getGlobal("Worker") as new (url: string) => {
      postMessage(d: unknown): void;
      addEventListener(t: string, h: unknown): void;
      removeEventListener(t: string, h: unknown): void;
      terminate(): void;
    };
    const w = new Worker("https://fake.com/worker.js");
    expect(() => w.postMessage({ type: "boot" })).not.toThrow();
    expect(() => w.addEventListener("message", () => {})).not.toThrow();
    expect(() => w.removeEventListener("message", () => {})).not.toThrow();
    expect(() => w.terminate()).not.toThrow();
  });

  test("idempotent — double install does not throw", () => {
    const sb = makeSandbox();
    expect(() => {
      installWorkerShim(sb, { bundleDir: "vendor/snap-bundle" });
      installWorkerShim(sb, { bundleDir: "vendor/snap-bundle" });
    }).not.toThrow();
  });

  test("URL.createObjectURL is patched (no throw on blob URL creation)", () => {
    const sb = makeSandbox();
    installWorkerShim(sb, { bundleDir: "vendor/snap-bundle" });
    // createObjectURL should be callable from within the sandbox realm.
    expect(() => {
      sb.runInContext(
        `URL.createObjectURL(new Blob(["importScripts('https://example.com/chunk.js');"], {type:'application/javascript'}))`,
        "test-blob",
      );
    }).not.toThrow();
  });

  test("two Sandboxes have independent Worker globals", () => {
    const sbA = makeSandbox();
    const sbB = makeSandbox();
    installWorkerShim(sbA, { bundleDir: "vendor/snap-bundle" });
    installWorkerShim(sbB, { bundleDir: "vendor/snap-bundle" });
    const WA = sbA.getGlobal("Worker");
    const WB = sbB.getGlobal("Worker");
    // Both are Worker classes but are distinct references (each Sandbox
    // creates a fresh class inside installWorkerShim).
    expect(WA).toBeDefined();
    expect(WB).toBeDefined();
    expect(WA).not.toBe(WB);
  });
});
