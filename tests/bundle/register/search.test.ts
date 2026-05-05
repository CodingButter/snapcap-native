/**
 * STATE-DRIVEN tests — `src/bundle/register/search.ts`.
 *
 * `searchRequestCodec` and `searchResponseCodec` delegate to `reach()`.
 * `toVmU8` is a cross-realm helper that wraps bytes — pure in host realm.
 * `sandboxRandomUUID` reads `sandbox.getGlobal("crypto").randomUUID()`.
 * `searchUsers` is a compound async op — tested with a stubbed fetch.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  sandboxRandomUUID,
  searchRequestCodec,
  searchResponseCodec,
  toVmU8,
} from "../../../src/bundle/register/search.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture } from "../../lib/fixtures/index.ts";

// ─── searchRequestCodec ───────────────────────────────────────────────────────

describe("bundle/register/search — searchRequestCodec(sandbox)", () => {
  test("returns the HY codec when global is present", () => {
    const fakeHY = { fromPartial: () => ({}), encode: () => ({ finish: () => new Uint8Array() }) };
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_HY", fakeHY)
      .build();

    expect(searchRequestCodec(sandbox)).toBe(fakeHY);
  });

  test("throws 'bundle entity not available' when absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => searchRequestCodec(sandbox)).toThrow(
      "searchRequestCodec: bundle entity not available",
    );
  });
});

// ─── searchResponseCodec ──────────────────────────────────────────────────────

describe("bundle/register/search — searchResponseCodec(sandbox)", () => {
  test("returns the JY codec when global is present", () => {
    const fakeJY = { decode: () => ({ sections: [] }) };
    const sandbox = mockSandbox()
      .withGlobal("__SNAPCAP_JY", fakeJY)
      .build();

    expect(searchResponseCodec(sandbox)).toBe(fakeJY);
  });

  test("throws 'bundle entity not available' when absent", () => {
    const sandbox = mockSandbox().build();
    expect(() => searchResponseCodec(sandbox)).toThrow(
      "searchResponseCodec: bundle entity not available",
    );
  });
});

// ─── toVmU8 (pure in host realm) ──────────────────────────────────────────────

describe("bundle/register/search — toVmU8(sandbox, src)", () => {
  test("returns a Uint8Array over the same bytes", () => {
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const src = new Uint8Array([1, 2, 3, 4]);
    const result = toVmU8(sandbox, src);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  test("accepts an ArrayBuffer input", () => {
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const buf = new Uint8Array([10, 20, 30]).buffer;
    const result = toVmU8(sandbox, buf);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([10, 20, 30]);
  });

  test("falls back to host Uint8Array when sandbox has no Uint8Array global", () => {
    const sandbox = mockSandbox().build(); // no globals set
    const src = new Uint8Array([99]);
    const result = toVmU8(sandbox, src);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(99);
  });
});

// ─── sandboxRandomUUID ────────────────────────────────────────────────────────

describe("bundle/register/search — sandboxRandomUUID(sandbox)", () => {
  test("returns a UUID string when crypto.randomUUID is present", () => {
    const fakeUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const sandbox = mockSandbox()
      .withGlobal("crypto", { randomUUID: () => fakeUUID })
      .build();

    expect(sandboxRandomUUID(sandbox)).toBe(fakeUUID);
  });

  test("returns empty string when crypto global is absent", () => {
    const sandbox = mockSandbox().build();
    expect(sandboxRandomUUID(sandbox)).toBe("");
  });

  test("returns empty string when crypto has no randomUUID method", () => {
    const sandbox = mockSandbox()
      .withGlobal("crypto", {})
      .build();

    expect(sandboxRandomUUID(sandbox)).toBe("");
  });
});
