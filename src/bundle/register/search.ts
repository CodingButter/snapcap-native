/**
 * Search-domain bundle accessors — request/response codecs, two
 * cross-realm helpers used to seed bundle-bound buffers, and the
 * compound `searchUsers` operation that composes them with
 * {@link defaultAuthedFetch} and {@link hostModule}.
 */
import { Sandbox } from "../../shims/sandbox.ts";
import type {
  DecodedSearchResponse,
  SearchRequestCodec,
  SearchResponseCodec,
} from "../types/index.ts";
import { defaultAuthedFetch, hostModule } from "./host.ts";
import { G_SEARCH_REQ_CODEC, G_SEARCH_RESP_CODEC } from "./patch-keys.ts";
import { reach } from "./reach.ts";

/**
 * Bundle's `SearchRequest` ts-proto codec — `HY` in chat module ~10409.
 *
 * Returns the live codec object; consumers call `.fromPartial(...)` and
 * `.encode(msg).finish()` to build the request body for the
 * `/search/search` POST. See {@link SearchRequestCodec}.
 *
 * @internal Bundle-layer accessor. Used by {@link searchUsers} below.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `HY` codec
 */
export const searchRequestCodec = (sandbox: Sandbox): SearchRequestCodec =>
  reach<SearchRequestCodec>(sandbox, G_SEARCH_REQ_CODEC, "searchRequestCodec");

/**
 * Bundle's `SearchResponse` ts-proto codec — `JY` in chat module ~10409.
 *
 * Returns the live codec object; consumers call `.decode(bytes)` to
 * parse the `/search/search` POST response. See {@link SearchResponseCodec}.
 *
 * @internal Bundle-layer accessor. Used by {@link searchUsers} below.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the live `JY` codec
 */
export const searchResponseCodec = (sandbox: Sandbox): SearchResponseCodec =>
  reach<SearchResponseCodec>(sandbox, G_SEARCH_RESP_CODEC, "searchResponseCodec");

/**
 * Wrap a host-realm `Uint8Array` (or `ArrayBuffer`) with the SANDBOX
 * realm's `Uint8Array` constructor.
 *
 * The bundle's protobuf reader (chat main ~byte 2840000) does an
 * `e instanceof Uint8Array` check before constructing a Reader;
 * cross-realm `Uint8Array`s fail that check because the sandbox
 * `vm.Context` has its own constructor (see `shims/sandbox.ts`).
 *
 * Falls back to host `Uint8Array` if the sandbox isn't initialized — the
 * resulting buffer will fail bundle decode, but that surfaces as a
 * cleaner error at call-site than throwing here.
 *
 * @internal Cross-realm helper for bundle-bound byte buffers.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param src - host-realm `Uint8Array` or `ArrayBuffer`
 * @returns a sandbox-realm `Uint8Array` over the same bytes
 */
export const toVmU8 = (sandbox: Sandbox, src: Uint8Array | ArrayBuffer): Uint8Array => {
  const SU8 = sandbox.getGlobal<typeof Uint8Array>("Uint8Array") ?? Uint8Array;
  return new SU8(src as ArrayBufferLike);
};

/**
 * Generate a UUID using the SANDBOX realm's `crypto.randomUUID`.
 *
 * Returns `""` (not undefined) when the sandbox `crypto` global is
 * missing — the bundle's search request accepts an empty `sessionId`
 * and a string fallback keeps consumer types simple.
 *
 * @internal Cross-realm helper used when seeding bundle-bound request
 * envelopes with a sessionId.
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns a hyphenated UUID string, or `""` when `crypto` is absent
 */
export const sandboxRandomUUID = (sandbox: Sandbox): string =>
  sandbox.getGlobal<{ randomUUID?: () => string }>("crypto")?.randomUUID?.() ?? "";

/**
 * Compound search operation — encodes the request, POSTs through the
 * bundle's `default-authed-fetch`, and decodes the response. The api
 * layer adapts the result into consumer-shape `User[]`.
 *
 * Lives here (not in api/) because it composes three register-internal
 * primitives (codecs + {@link defaultAuthedFetch} + {@link hostModule})
 * and the api rule forbids reaching for those directly. Returns the raw
 * decoded shape so the api layer owns the field-mapping decisions.
 *
 * `sectionType` defaults to 2 (`SECTION_TYPE_ADD_FRIENDS`); `origin`
 * defaults to 21 (`ORIGIN_DWEB`); `numToReturn` defaults to 20 — all
 * matching what the SPA sends from its search-bar code path.
 *
 * @internal Bundle-layer composition. Public consumers reach search via
 * `SnapcapClient.searchUsers()` (see `src/api/search.ts`).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @param query - free-form search string (username / display-name fragment)
 * @param opts - optional overrides for `sectionType` / `numToReturn` / `origin`
 * @returns the raw decoded {@link DecodedSearchResponse}
 */
export const searchUsers = async (
  sandbox: Sandbox,
  query: string,
  opts: { sectionType?: number; numToReturn?: number; origin?: number } = {},
): Promise<DecodedSearchResponse> => {
  const HY = searchRequestCodec(sandbox);
  const JY = searchResponseCodec(sandbox);
  const sectionType = opts.sectionType ?? 2; // SECTION_TYPE_ADD_FRIENDS
  const reqMsg = HY.fromPartial({
    queryString: query,
    origin: opts.origin ?? 21, // ORIGIN_DWEB
    requestOptions: {
      sectionsToReturn: [sectionType],
      numToReturn: opts.numToReturn ?? 20,
    },
    sessionId: sandboxRandomUUID(sandbox),
  });
  const body = toVmU8(sandbox, HY.encode(reqMsg).finish());
  const url = `${hostModule(sandbox).r5}/search/search`;
  const resp = await defaultAuthedFetch(sandbox).s(url, { method: "POST", body });
  if (!resp.ok) return { sections: [] };
  return JY.decode(toVmU8(sandbox, await resp.arrayBuffer()));
};
