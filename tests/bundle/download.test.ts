/**
 * NETWORK tests — `src/bundle/download.ts`.
 *
 * `ensureBundle` shells out to `scripts/download-bundle.sh` via
 * `child_process.spawn`. We mock `spawn` + `fs` primitives to avoid any
 * real network call.
 *
 * Per the task brief: mock `child_process.spawn` and assert the bash
 * command shape. NOT an actual download.
 *
 * NOTE: `ensureBundle` has a module-scope `ensured` flag (the lint
 * allowlist exempts it as "idempotent process-wide bootstrap"). Tests
 * that want a clean fast path must read `hasUsableBundle → true` so
 * `ensured` gets set cleanly on first call. The flag is process-wide, so
 * test order matters: fast-path tests before error-path tests.
 *
 * We use `mock.module` from bun:test to patch `node:fs` and
 * `node:child_process` per-test scenario.
 */
import { describe, expect, test, mock, afterEach } from "bun:test";
import { EventEmitter } from "node:events";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a fake EventEmitter that behaves like a ChildProcess. */
function makeFakeProc(exitCode: number, delay = 0): EventEmitter & { on: Function } {
  const proc = new EventEmitter() as EventEmitter & { on: Function };
  setTimeout(() => proc.emit("close", exitCode), delay);
  return proc;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("bundle/download — ensureBundle (bash command shape)", () => {
  test("spawns bash with the download script and passes OUT_DIR env", async () => {
    // Reset module cache so ensured=false for this scenario
    // We test the spawn shape by importing fresh after mocking

    const spawnCalls: Array<{
      cmd: string;
      args: string[];
      opts: Record<string, unknown>;
    }> = [];

    // Mock fs to simulate "bundle already present" (fast path — avoids spawn)
    // We intentionally test the spawn path, so simulate "bundle missing".
    mock.module("node:fs", () => ({
      existsSync: (p: string) => {
        // Simulate: bundleDir exists, mediaDir exists, kameleon.wasm present,
        // chatDir exists, but no .js files → hasChatJs = false → download needed
        if (p.includes("cf-st.sc-cdn.net/dw")) return true;
        if (p.includes("static.snapchat.com/accounts/_next/static/media")) return true;
        if (p.endsWith("test-bundle-dir")) return true;
        // locateDownloadScript candidate → simulate the script file exists
        if (p.includes("download-bundle.sh")) return true;
        return false;
      },
      readdirSync: (p: string) => {
        if (p.includes("media")) return ["kameleon.abc123.wasm"];
        if (p.includes("cf-st.sc-cdn.net/dw")) return []; // no .js → triggers download
        return [];
      },
      statSync: () => ({ size: 0 }),
    }));

    mock.module("node:child_process", () => ({
      spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
        spawnCalls.push({ cmd, args, opts });
        const proc = makeFakeProc(0, 5);
        return proc;
      },
    }));

    // After spawn succeeds, hasUsableBundle is re-checked. Mock it now to
    // return true so ensureBundle doesn't throw "still missing".
    // We patch readdirSync to return a big .js after first call.
    let jsCheckCount = 0;
    mock.module("node:fs", () => ({
      existsSync: () => true,
      readdirSync: (p: string) => {
        if (p.includes("media")) return ["kameleon.abc123.wasm"];
        if (p.includes("cf-st.sc-cdn.net/dw")) {
          jsCheckCount++;
          // First call: no js (trigger download). Second call: has js (post-download check).
          if (jsCheckCount === 1) return [];
          return ["main.abc123.js"];
        }
        return [];
      },
      statSync: () => ({ size: 200_000 }),
    }));

    mock.module("node:child_process", () => ({
      spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
        spawnCalls.push({ cmd, args, opts });
        return makeFakeProc(0, 5);
      },
    }));

    const { ensureBundle } = await import("../../src/bundle/download.ts?nocache=" + Date.now());

    await ensureBundle("/tmp/test-bundle-dir");

    // Assert command shape: bash [script-path]
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    const call = spawnCalls[0]!;
    expect(call.cmd).toBe("bash");
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.args[0]).toMatch(/download-bundle\.sh$/);

    // OUT_DIR must be in the env
    const env = (call.opts.env ?? {}) as Record<string, string>;
    expect(env.OUT_DIR).toBe("/tmp/test-bundle-dir");
  });

  test("resolves immediately when bundle is already present (ensured fast-path)", async () => {
    // Simulate a fully-populated bundle dir
    mock.module("node:fs", () => ({
      existsSync: () => true,
      readdirSync: (p: string) => {
        if (p.includes("media")) return ["kameleon.abc123.wasm"];
        return ["main.bundle.js"];
      },
      statSync: () => ({ size: 500_000 }),
    }));

    const spawnCalls: unknown[] = [];
    mock.module("node:child_process", () => ({
      spawn: (...args: unknown[]) => {
        spawnCalls.push(args);
        return makeFakeProc(0);
      },
    }));

    const { ensureBundle } = await import("../../src/bundle/download.ts?fast=" + Date.now());
    await ensureBundle("/tmp/already-there-bundle");

    // spawn should NOT be called — bundle was already present
    expect(spawnCalls).toHaveLength(0);
  });

  test("throws when script exits non-zero", async () => {
    let jsCheckCount = 0;
    mock.module("node:fs", () => ({
      existsSync: () => true,
      readdirSync: (p: string) => {
        if (p.includes("media")) return ["kameleon.abc123.wasm"];
        if (p.includes("cf-st.sc-cdn.net/dw")) {
          jsCheckCount++;
          return jsCheckCount > 10 ? ["main.js"] : [];
        }
        return [];
      },
      statSync: () => ({ size: 200_000 }),
    }));

    mock.module("node:child_process", () => ({
      spawn: () => makeFakeProc(1, 5),
    }));

    const { ensureBundle } = await import("../../src/bundle/download.ts?fail=" + Date.now());
    await expect(ensureBundle("/tmp/fail-bundle")).rejects.toThrow(
      "download-bundle.sh exited with code 1",
    );
  });
});
