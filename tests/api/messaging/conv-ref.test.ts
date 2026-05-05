/**
 * PURE tests — `src/api/messaging/conv-ref.ts`.
 *
 * `buildConvRef` — builds a realm-local `{id: Uint8Array, str}` envelope.
 * `fireBundleCall` — fire-and-forget wrapper that swallows sync throws +
 *   async rejections.
 *
 * `buildConvRef` is async only because it calls `import("node:vm")` to
 * resolve `Uint8Array` in the target realm. In tests we pass a real vm
 * Context so the output is a genuine vm-realm Uint8Array.  We assert on
 * the `.str` field (deterministic) and the `.id` byte values (derived from
 * `uuidToBytes`).
 */
import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { buildConvRef, fireBundleCall } from "../../../src/api/messaging/conv-ref.ts";
import type { StandaloneChatRealm } from "../../../src/auth/fidelius-mint.ts";

// ── Fixture ────────────────────────────────────────────────────────────────────

const SAMPLE_CONV_ID = "527be2ff-aaec-4622-9c68-79d200b8bdc1";

/**
 * Build a minimal `StandaloneChatRealm` stub whose `.context` is a real
 * `vm.Context` so `buildConvRef` can call `vm.runInContext("Uint8Array", ...)`.
 */
function makeStubRealm(): StandaloneChatRealm {
  const context = vm.createContext({});
  return { context } as unknown as StandaloneChatRealm;
}

// ── buildConvRef ───────────────────────────────────────────────────────────────

describe("messaging/conv-ref — buildConvRef", () => {
  test("returns an object with str equal to the input convId", async () => {
    const realm = makeStubRealm();
    const ref = await buildConvRef(realm, SAMPLE_CONV_ID);
    expect(ref.str).toBe(SAMPLE_CONV_ID);
  });

  test("id is a typed array of length 16", async () => {
    const realm = makeStubRealm();
    const ref = await buildConvRef(realm, SAMPLE_CONV_ID);
    // The id is born in the vm context; host-realm instanceof check fails
    // cross-realm. Assert on the byte length directly via the .byteLength
    // property and that it is array-like with numeric indices.
    expect(ref.id.byteLength).toBe(16);
    expect(typeof ref.id[0]).toBe("number");
  });

  test("id bytes are deterministic for the same UUID", async () => {
    const realm = makeStubRealm();
    const ref1 = await buildConvRef(realm, SAMPLE_CONV_ID);
    const ref2 = await buildConvRef(realm, SAMPLE_CONV_ID);
    expect(Array.from(ref1.id)).toEqual(Array.from(ref2.id));
  });

  test("id bytes differ for a different UUID", async () => {
    const realm = makeStubRealm();
    const ref1 = await buildConvRef(realm, SAMPLE_CONV_ID);
    const ref2 = await buildConvRef(realm, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(Array.from(ref1.id)).not.toEqual(Array.from(ref2.id));
  });

  test("all-zeros UUID produces a 16-byte zero buffer", async () => {
    const realm = makeStubRealm();
    const ref = await buildConvRef(realm, "00000000-0000-0000-0000-000000000000");
    expect(Array.from(ref.id).every((b) => b === 0)).toBe(true);
  });
});

// ── fireBundleCall ─────────────────────────────────────────────────────────────

describe("messaging/conv-ref — fireBundleCall", () => {
  test("invokes the supplied function synchronously", () => {
    let called = false;
    fireBundleCall(() => { called = true; });
    expect(called).toBe(true);
  });

  test("swallows a synchronous throw without propagating", () => {
    expect(() => {
      fireBundleCall(() => { throw new Error("intentional sync throw"); });
    }).not.toThrow();
  });

  test("swallows an async rejection without propagating", async () => {
    // Give the microtask queue a turn so the rejection handler runs.
    await expect(
      new Promise<void>((resolve) => {
        fireBundleCall(() => Promise.reject(new Error("intentional async reject")));
        setTimeout(resolve, 0);
      }),
    ).resolves.toBeUndefined();
  });

  test("returns void regardless of the function's return value", () => {
    const result = fireBundleCall(() => 42);
    expect(result).toBeUndefined();
  });

  test("if fn returns a non-thenable, does not throw", () => {
    expect(() => fireBundleCall(() => null)).not.toThrow();
    expect(() => fireBundleCall(() => "string")).not.toThrow();
    expect(() => fireBundleCall(() => 0)).not.toThrow();
  });
});
