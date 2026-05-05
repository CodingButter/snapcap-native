/**
 * `search()` — Snap user-index search.
 *
 * Stateless free function over a `ClientContext` getter; the
 * {@link Friends} class trampolines to it.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import { searchUsers } from "../../bundle/register/index.ts";
import { extractUserId } from "../_helpers.ts";
import type { User } from "./types.ts";

/** {@inheritDoc IFriendsManager.search} */
export async function searchFriends(
  getCtx: () => Promise<ClientContext>,
  query: string,
): Promise<User[]> {
  const ctx = await getCtx();
  if (!query) return [];
  // SECTION_TYPE_ADD_FRIENDS = 2 (verified against bundle/9846…js at
  // offsets 1304870/1435000). `searchUsers` defaults to that section.
  const SECTION_TYPE_ADD_FRIENDS = 2;
  const decoded = await searchUsers(ctx.sandbox, query);
  const section = decoded.sections?.find((s) => s.sectionType === SECTION_TYPE_ADD_FRIENDS);
  const results = section?.results ?? [];
  const out: User[] = [];
  for (const r of results) {
    // Result is a oneof — `result.$case === "user"` carries the user payload.
    const inner = r.result;
    if (!inner || inner.$case !== "user" || !inner.user) continue;
    const u = inner.user;
    const userId = extractUserId(u);
    if (!userId) continue;
    const username = u.mutableUsername ?? u.username ?? "";
    if (!username) continue;
    out.push({ userId, username, displayName: u.displayName });
  }
  return out;
}
