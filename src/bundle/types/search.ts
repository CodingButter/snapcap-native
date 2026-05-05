/**
 * Search wire shapes — the closure-private chat-bundle codecs the
 * source-patch surfaces as `__SNAPCAP_HY` (request) and `__SNAPCAP_JY`
 * (response), plus the decoded shape produced by
 * `__SNAPCAP_JY.decode(...)`.
 *
 * The decoded response is a flat sections array; consumers pick the
 * section they care about by `sectionType` (`SearchSectionType` enum,
 * `2 = SECTION_TYPE_ADD_FRIENDS` is what `Friends.search()` reads).
 */

/**
 * `__SNAPCAP_HY` — the bundle's `SearchRequest` ts-proto message codec.
 * Lives in chat module ~10409 alongside the FriendAction client. Source-
 * patched via `chat-loader.ts`. Produces the request envelope POSTed to
 * `/search/search`.
 *
 * @internal Bundle wire-format type.
 */
export interface SearchRequestCodec {
  fromPartial(p: Record<string, unknown>): unknown;
  encode(req: unknown): { finish(): Uint8Array };
}

/**
 * `__SNAPCAP_JY` — the bundle's `SearchResponse` ts-proto message codec.
 * Decodes the `/search/search` POST response into
 * {@link DecodedSearchResponse}.
 *
 * @internal Bundle wire-format type.
 */
export interface SearchResponseCodec {
  decode(b: Uint8Array): DecodedSearchResponse;
}

/**
 * One result row inside a {@link DecodedSearchResponse} section. The
 * bundle's search codec emits `id` as a hyphenated UUID string but be
 * tolerant of {@link Uuid64Pair} and 16-byte buffer fallbacks too —
 * earlier traces showed both shapes depending on origin/sectionType.
 *
 * @internal Bundle wire-format type.
 */
export interface DecodedSearchUserResult {
  id?: string | Uint8Array | { highBits?: bigint | string; lowBits?: bigint | string };
  userId?: string;
  username?: string;
  mutableUsername?: string;
  displayName?: string;
}

/**
 * Section envelope inside {@link DecodedSearchResponse}. `sectionType`
 * mirrors the bundle's `SearchSectionType` enum
 * (2 = `SECTION_TYPE_ADD_FRIENDS`). The user payload is a oneof —
 * `result.$case === "user"` carries the {@link DecodedSearchUserResult}.
 *
 * @internal Bundle wire-format type.
 */
export interface DecodedSearchSection {
  sectionType?: number;
  results?: Array<{
    result?: { $case?: string; user?: DecodedSearchUserResult; [k: string]: unknown };
  }>;
  /** Convenience flat list — present on some section variants. */
  users?: DecodedSearchUserResult[];
}

/**
 * Decoded `/search/search` response — what
 * {@link SearchResponseCodec}.decode yields. Sections array is flat;
 * consumers pick the section they care about by `sectionType`.
 *
 * @internal Bundle wire-format type.
 */
export interface DecodedSearchResponse {
  sections: DecodedSearchSection[];
}
