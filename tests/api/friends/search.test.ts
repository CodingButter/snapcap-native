/**
 * NETWORK tests — `src/api/friends/search.ts`.
 *
 * `searchFriends` calls `searchUsers(ctx.sandbox, query)` which:
 *   1. reaches `searchRequestCodec` via `sandbox.getGlobal("__SNAPCAP_HY")`
 *   2. reaches `searchResponseCodec` via `sandbox.getGlobal("__SNAPCAP_JY")`
 *   3. reaches `hostModule` via `wreq(MOD_HOST)` → `{r5: "https://web.snapchat.com"}`
 *   4. reaches `defaultAuthedFetch` via `wreq(MOD_DEFAULT_AUTHED_FETCH)` → `{s}`
 *   5. POSTs and decodes the response
 *
 * We inject all five stubs into MockSandbox.  The test drives different
 * canned `DecodedSearchResponse` shapes through the decode path to verify
 * the api-layer mapping logic (`sectionType` filtering, `$case` oneof,
 * empty-query short-circuit, etc.).
 */
import { describe, expect, test } from "bun:test";
import { searchFriends } from "../../../src/api/friends/search.ts";
import { MOD_DEFAULT_AUTHED_FETCH, MOD_HOST } from "../../../src/bundle/register/module-ids.ts";
import { MemoryDataStore } from "../../../src/storage/data-store.ts";
import { mockSandbox } from "../../lib/mock-sandbox.ts";
import { chatStateFixture, userSliceFixture } from "../../lib/fixtures/index.ts";
import { MOD_CHAT_STORE } from "../../../src/bundle/register/module-ids.ts";
import type { ClientContext } from "../../../src/api/_context.ts";
import type { DecodedSearchResponse } from "../../../src/bundle/types/index.ts";

// ── fake search infrastructure ────────────────────────────────────────────────

/**
 * Build a fake chat-bundle wreq function that serves every module the
 * `searchUsers` registry path reaches, plus MOD_CHAT_STORE.
 *
 * @param fetchResponse - canned `DecodedSearchResponse` the fake fetch returns
 */
function makeFakeSearchSandbox(fetchResponse: DecodedSearchResponse): ClientContext {
  // A minimal response body — the fake decode always returns `fetchResponse`.
  const fakeRespBytes = new Uint8Array([1, 2, 3]);

  // Fake SearchRequestCodec (`__SNAPCAP_HY`).
  const fakeHY = {
    fromPartial: (x: object) => x,
    encode: (_x: unknown) => ({ finish: () => new Uint8Array(4) }),
  };

  // Fake SearchResponseCodec (`__SNAPCAP_JY`).
  const fakeJY = {
    decode: (_bytes: unknown) => fetchResponse,
  };

  // Fake Response object returned by defaultAuthedFetch.s().
  const fakeResp = {
    ok: true,
    arrayBuffer: async () => fakeRespBytes.buffer,
  };

  // Fake defaultAuthedFetch module.
  const fakeAuthedFetch = { s: async (_url: unknown, _opts: unknown) => fakeResp };

  // Fake host module.
  const fakeHost = { r5: "https://web.snapchat.com" };

  // Minimal chat-store state (not used by search, but MOD_CHAT_STORE is
  // also wired through the same wreq).
  const fakeStore = {
    getState: () => chatStateFixture({ user: userSliceFixture() }),
    setState: () => {},
    subscribe: () => () => {},
  };

  // Build a wreq that handles all needed module IDs.
  const modules: Record<string, unknown> = {
    [MOD_CHAT_STORE]: { M: fakeStore },
    [MOD_HOST]: fakeHost,
    [MOD_DEFAULT_AUTHED_FETCH]: fakeAuthedFetch,
  };
  const wreq = (id: string): unknown => {
    if (id in modules) return modules[id];
    throw new Error(`test wreq: no module ${id} stubbed`);
  };
  (wreq as unknown as { m: Record<string, unknown> }).m = modules;

  const sandbox = mockSandbox()
    .withGlobal("__snapcap_chat_p", wreq)
    .withGlobal("__SNAPCAP_HY", fakeHY)
    .withGlobal("__SNAPCAP_JY", fakeJY)
    .build();

  return { sandbox, dataStore: new MemoryDataStore() } as unknown as ClientContext;
}

function getCtxThunk(ctx: ClientContext): () => Promise<ClientContext> {
  return () => Promise.resolve(ctx);
}

/** Build a canned `DecodedSearchResponse` with section type 2 and a user result. */
function cannedSearchResponse(
  userId: string,
  username: string,
  displayName?: string,
): DecodedSearchResponse {
  return {
    sections: [
      {
        sectionType: 2, // SECTION_TYPE_ADD_FRIENDS
        results: [
          {
            result: {
              $case: "user" as const,
              user: {
                userId,
                username,
                mutableUsername: username,
                displayName,
              },
            },
          },
        ],
      },
    ],
  };
}

// ── searchFriends ─────────────────────────────────────────────────────────────

describe("friends/search — searchFriends", () => {
  test("returns empty array for an empty query string", async () => {
    const ctx = makeFakeSearchSandbox({ sections: [] });
    const results = await searchFriends(getCtxThunk(ctx), "");
    expect(results).toEqual([]);
  });

  test("returns mapped users from sectionType=2 results", async () => {
    const ctx = makeFakeSearchSandbox(
      cannedSearchResponse("aaa-id", "alice", "Alice A"),
    );
    const results = await searchFriends(getCtxThunk(ctx), "alice");
    expect(results).toHaveLength(1);
    expect(results[0]?.userId).toBe("aaa-id");
    expect(results[0]?.username).toBe("alice");
    expect(results[0]?.displayName).toBe("Alice A");
  });

  test("skips results from non-sectionType-2 sections", async () => {
    const ctx = makeFakeSearchSandbox({
      sections: [
        {
          sectionType: 99, // not SECTION_TYPE_ADD_FRIENDS
          results: [
            {
              result: {
                $case: "user" as const,
                user: { userId: "should-be-skipped", username: "ghost", mutableUsername: "ghost" },
              },
            },
          ],
        },
      ],
    });
    const results = await searchFriends(getCtxThunk(ctx), "ghost");
    expect(results).toEqual([]);
  });

  test("skips oneof results where $case is not 'user'", async () => {
    const ctx = makeFakeSearchSandbox({
      sections: [
        {
          sectionType: 2,
          results: [
            {
              result: { $case: "suggestion" as unknown as "user", user: undefined },
            },
          ],
        },
      ],
    });
    const results = await searchFriends(getCtxThunk(ctx), "query");
    expect(results).toEqual([]);
  });

  test("skips results with no userId", async () => {
    const ctx = makeFakeSearchSandbox({
      sections: [
        {
          sectionType: 2,
          results: [
            {
              result: {
                $case: "user" as const,
                user: { userId: "", username: "nobody", mutableUsername: "nobody" },
              },
            },
          ],
        },
      ],
    });
    const results = await searchFriends(getCtxThunk(ctx), "nobody");
    expect(results).toEqual([]);
  });

  test("skips results with no username after mutableUsername fallback", async () => {
    const ctx = makeFakeSearchSandbox({
      sections: [
        {
          sectionType: 2,
          results: [
            {
              result: {
                $case: "user" as const,
                user: { userId: "some-id", username: "", mutableUsername: "" },
              },
            },
          ],
        },
      ],
    });
    const results = await searchFriends(getCtxThunk(ctx), "query");
    expect(results).toEqual([]);
  });

  test("returns empty array when sections array is undefined", async () => {
    const ctx = makeFakeSearchSandbox({} as DecodedSearchResponse);
    const results = await searchFriends(getCtxThunk(ctx), "alice");
    expect(results).toEqual([]);
  });

  test("returns multiple users from multiple result entries in the same section", async () => {
    const ctx = makeFakeSearchSandbox({
      sections: [
        {
          sectionType: 2,
          results: [
            { result: { $case: "user" as const, user: { userId: "id1", username: "u1", mutableUsername: "u1" } } },
            { result: { $case: "user" as const, user: { userId: "id2", username: "u2", mutableUsername: "u2" } } },
          ],
        },
      ],
    });
    const results = await searchFriends(getCtxThunk(ctx), "u");
    expect(results).toHaveLength(2);
    expect(results[0]?.username).toBe("u1");
    expect(results[1]?.username).toBe("u2");
  });
});
