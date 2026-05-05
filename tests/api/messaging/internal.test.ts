/**
 * PURE tests — `src/api/messaging/internal.ts`.
 *
 * `Cell<T>` and `Slot<T>` are interface-only (no runtime body); the
 * test here confirms the structural contract used throughout the
 * messaging sibling files: a `Cell` is a `{ value: T }` box and a
 * `Slot` exposes a `get() / set()` pair that the manager writes through.
 *
 * Because the interfaces carry no executable logic, these tests are
 * construction-level smoke tests: make an object that satisfies the
 * shape, assert the read/write semantics hold at runtime under TS's
 * structural rules.
 */
import { describe, expect, test } from "bun:test";
import type { Cell, Slot } from "../../../src/api/messaging/internal.ts";

// ── Cell<T> ────────────────────────────────────────────────────────────────────

describe("messaging/internal — Cell<T>", () => {
  test("Cell wraps a mutable value and read-back is identity", () => {
    const cell: Cell<number> = { value: 0 };
    cell.value = 42;
    expect(cell.value).toBe(42);
  });

  test("Cell<boolean> starts false, flips to true", () => {
    const cell: Cell<boolean> = { value: false };
    expect(cell.value).toBe(false);
    cell.value = true;
    expect(cell.value).toBe(true);
  });

  test("Cell<string | undefined> round-trips undefined → string → undefined", () => {
    const cell: Cell<string | undefined> = { value: undefined };
    expect(cell.value).toBeUndefined();
    cell.value = "hello";
    expect(cell.value).toBe("hello");
    cell.value = undefined;
    expect(cell.value).toBeUndefined();
  });

  test("two Cell instances are independent (no shared state)", () => {
    const a: Cell<number> = { value: 1 };
    const b: Cell<number> = { value: 2 };
    a.value = 99;
    expect(b.value).toBe(2);
  });
});

// ── Slot<T> ────────────────────────────────────────────────────────────────────

describe("messaging/internal — Slot<T>", () => {
  /**
   * Build a concrete `Slot<T>` backed by a local variable, mirroring
   * exactly what the `Messaging` constructor does for `#session` and
   * `#realm`.
   */
  function makeSlot<T>(): Slot<T> {
    let inner: T | undefined;
    return {
      get: () => inner,
      set: (v) => { inner = v; },
    };
  }

  test("Slot starts undefined", () => {
    const slot = makeSlot<string>();
    expect(slot.get()).toBeUndefined();
  });

  test("set then get round-trips a value", () => {
    const slot = makeSlot<string>();
    slot.set("session-value");
    expect(slot.get()).toBe("session-value");
  });

  test("set(undefined) clears a previously set value", () => {
    const slot = makeSlot<{ id: string }>();
    slot.set({ id: "abc" });
    expect(slot.get()).toEqual({ id: "abc" });
    slot.set(undefined);
    expect(slot.get()).toBeUndefined();
  });

  test("two Slots are independent", () => {
    const a = makeSlot<number>();
    const b = makeSlot<number>();
    a.set(7);
    expect(b.get()).toBeUndefined();
  });
});
