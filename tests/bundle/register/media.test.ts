/**
 * STATE-DRIVEN tests — `src/bundle/register/media.ts`.
 *
 * `uploadDelegate` resolves via `reach()`.
 * `destinationsModule` and `storyDescModule` resolve via `reachModule`.
 */
import { describe, expect, test } from "bun:test";
import {
  destinationsModule,
  storyDescModule,
  uploadDelegate,
} from "../../../src/bundle/register/media.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture } from "../../lib/fixtures/index.ts";
import {
  MOD_DESTINATIONS,
  MOD_STORY_DESC,
} from "../../../src/bundle/register/module-ids.ts";

function makePopulatedSandbox() {
  return mockSandbox().withChatStore(chatStateFixture()).build();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectModule(sandbox: any, id: string, val: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wreq = (sandbox.getGlobal as any)("__snapcap_chat_p") as { m: Record<string, () => unknown> } | undefined;
  if (wreq) wreq.m[id] = () => val;
}

// ─── uploadDelegate ───────────────────────────────────────────────────────────

describe("bundle/register/media — uploadDelegate(sandbox)", () => {
  test("returns Fi upload delegate when global is present", () => {
    const fakeFi = { uploadMedia: () => {}, uploadMediaReferences: () => {} };
    const sandbox = makePopulatedSandbox();
    sandbox.setGlobal("__SNAPCAP_FI", fakeFi);

    expect(uploadDelegate(sandbox) as unknown).toBe(fakeFi);
  });

  test("throws 'bundle entity not available' when global is absent", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => uploadDelegate(sandbox)).toThrow(
      "uploadDelegate: bundle entity not available",
    );
  });
});

// ─── destinationsModule ───────────────────────────────────────────────────────

describe("bundle/register/media — destinationsModule(sandbox)", () => {
  test("returns destinations module when stubbed", () => {
    const fakeDestinations = { Ju: () => ({}) };
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_DESTINATIONS, fakeDestinations);

    expect(destinationsModule(sandbox) as unknown).toBe(fakeDestinations);
  });

  test("throws when module is absent", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => destinationsModule(sandbox)).toThrow(
      `destinationsModule: chat wreq lookup of module ${MOD_DESTINATIONS} failed`,
    );
  });
});

// ─── storyDescModule ──────────────────────────────────────────────────────────

describe("bundle/register/media — storyDescModule(sandbox)", () => {
  test("returns story desc module when stubbed", () => {
    const fakeStoryDesc = { R9: () => [], ge: () => ({}) };
    const sandbox = makePopulatedSandbox();
    injectModule(sandbox, MOD_STORY_DESC, fakeStoryDesc);

    expect(storyDescModule(sandbox) as unknown).toBe(fakeStoryDesc);
  });

  test("throws when module is absent", () => {
    const sandbox = makePopulatedSandbox();
    expect(() => storyDescModule(sandbox)).toThrow(
      `storyDescModule: chat wreq lookup of module ${MOD_STORY_DESC} failed`,
    );
  });
});
