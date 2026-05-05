/**
 * STATE-DRIVEN tests — `src/bundle/register/host.ts`.
 *
 * `hostModule`, `defaultAuthedFetch`, `atlasGwClass`, and `atlasClient` all
 * resolve through `reachModule` or `reach`. Most are one-line wrappers —
 * tested for (a) success path, (b) error path.
 *
 * `atlasGwClass` has shape-validation logic (scans exports for
 * `SyncFriendData`) — that deserves a dedicated case.
 */
import { describe, expect, test } from "bun:test";
import {
  atlasClient,
  atlasGwClass,
  defaultAuthedFetch,
  hostModule,
} from "../../../src/bundle/register/host.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture } from "../../lib/fixtures/index.ts";
import {
  MOD_ATLAS_CLASS,
  MOD_DEFAULT_AUTHED_FETCH,
  MOD_HOST,
} from "../../../src/bundle/register/module-ids.ts";

// Helper: inject a module factory into the mock wreq
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectModule(sandbox: any, id: string, factory: () => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wreq = (sandbox.getGlobal as any)("__snapcap_chat_p") as { m: Record<string, () => unknown> } | undefined;
  if (wreq) wreq.m[id] = factory;
}

function makePopulatedSandbox() {
  return mockSandbox().withChatStore(chatStateFixture()).build();
}

// ─── hostModule ───────────────────────────────────────────────────────────────

describe("bundle/register/host — hostModule(sandbox)", () => {
  test("returns host module when stubbed in wreq", () => {
    const fakeHost = { r5: "https://web.snapchat.com" };
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_HOST, () => fakeHost);

    expect(hostModule(sandbox) as unknown).toBe(fakeHost);
  });

  test("throws when module is absent", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => hostModule(sandbox)).toThrow(
      `hostModule: chat wreq lookup of module ${MOD_HOST} failed`,
    );
  });
});

// ─── defaultAuthedFetch ───────────────────────────────────────────────────────

describe("bundle/register/host — defaultAuthedFetch(sandbox)", () => {
  test("returns the module when `s` is a function", () => {
    const fakeModule = { s: async () => new Response("", { status: 200 }) };
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_DEFAULT_AUTHED_FETCH, () => fakeModule);

    const result = defaultAuthedFetch(sandbox);
    expect(result).toBe(fakeModule);
    expect(typeof result.s).toBe("function");
  });

  test("throws 'shape shifted' when module has no `s` function", () => {
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_DEFAULT_AUTHED_FETCH, () => ({ noS: true }));

    expect(() => defaultAuthedFetch(sandbox)).toThrow("shape shifted");
  });

  test("throws when module is absent entirely", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => defaultAuthedFetch(sandbox)).toThrow(
      `defaultAuthedFetch: chat wreq lookup of module ${MOD_DEFAULT_AUTHED_FETCH} failed`,
    );
  });
});

// ─── atlasGwClass ─────────────────────────────────────────────────────────────

describe("bundle/register/host — atlasGwClass(sandbox)", () => {
  test("returns the class whose prototype has SyncFriendData", () => {
    class FakeAtlas { SyncFriendData() {} }
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_ATLAS_CLASS, () => ({ FakeAtlas, other: "nope" }));

    const result = atlasGwClass(sandbox);
    expect(result as unknown).toBe(FakeAtlas);
  });

  test("throws 'not found' when no export has SyncFriendData", () => {
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_ATLAS_CLASS, () => ({ noMethod: class {} }));

    expect(() => atlasGwClass(sandbox)).toThrow("AtlasGw class not found");
  });

  test("throws when module is absent", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => atlasGwClass(sandbox)).toThrow(
      `atlasGwClass: chat wreq lookup of module ${MOD_ATLAS_CLASS} failed`,
    );
  });

  test("skips non-function exports when scanning", () => {
    class GoodAtlas { SyncFriendData() {} }
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_ATLAS_CLASS, () => ({
      notAClass: "string",
      alsoNotAClass: 42,
      GoodAtlas,
    }));

    expect(atlasGwClass(sandbox) as unknown).toBe(GoodAtlas);
  });
});

// ─── atlasClient ─────────────────────────────────────────────────────────────

describe("bundle/register/host — atlasClient(sandbox)", () => {
  test("returns the atlas client when global is present", () => {
    const fakeAtlas = { SyncFriendData: () => {} };
    const sandbox = makePopulatedSandbox();
    sandbox.setGlobal("__SNAPCAP_ATLAS", fakeAtlas);

    expect(atlasClient(sandbox) as unknown).toBe(fakeAtlas);
  });

  test("throws 'bundle entity not available' when global is absent", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => atlasClient(sandbox)).toThrow(
      "atlasClient: bundle entity not available",
    );
  });
});
