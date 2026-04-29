/**
 * User search — find Snapchatters by username/display name.
 *
 * Endpoint: POST https://web.snapchat.com/search/search
 *
 * Unlike the rest of Snap's RPCs, this one is **NOT** gRPC-Web framed —
 * it's a raw protobuf POST. No 5-byte length prefix, no x-grpc-web header.
 * Same auth (Bearer + cookie + x-snap-client-user-agent) though.
 *
 * The full response is a multi-section structure (Add Friends, Friends,
 * Lenses, Stories, etc.). For v1 we surface just user matches.
 */
import { ProtoWriter, ProtoReader, bytesToUuid } from "../transport/proto-encode.ts";
import type { CookieJar } from "tough-cookie";
import { makeJarFetch } from "../transport/cookies.ts";
import { User } from "./user.ts";

export type SearchUsersOpts = {
  jar: CookieJar;
  userAgent: string;
  bearer: string;
  origin?: string;
  referer?: string;
  /** Called on 401 to mint a fresh bearer; if returns null, the 401 propagates. */
  refreshBearer?: () => Promise<string | null>;
};

/**
 * Search Snap's user index. Returns users found in the "Add Friends" /
 * "Friends" sections of the response, conflated.
 *
 * `pageSize` defaults to 20 (the value web sends). Snap caps somewhere; we
 * don't try to paginate.
 */
export async function searchUsers(
  query: string,
  opts: SearchUsersOpts,
  pageSize: number = 20,
): Promise<User[]> {
  // wire shape of the request:
  //   { 1: string query,
  //     2: int32 (always 21 in capture — likely a feature-flag bitfield),
  //     3: { 5: bytes(1)=0x02, 7: int32 pageSize },
  //     6: string sessionUuid }
  const w = new ProtoWriter();
  w.fieldString(1, query);
  w.fieldVarint(2, 21);
  w.fieldMessage(3, (inner) => {
    inner.fieldBytes(5, new Uint8Array([2]));
    inner.fieldVarint(7, pageSize);
  });
  w.fieldString(6, crypto.randomUUID());
  const reqBytes = w.finish();

  const jarFetch = makeJarFetch(opts.jar, opts.userAgent);
  const send = (bearer: string) => jarFetch("https://web.snapchat.com/search/search", {
    method: "POST",
    headers: {
      "content-type": "application/x-protobuf",
      authorization: `Bearer ${bearer}`,
      "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
      origin: opts.origin ?? "https://www.snapchat.com",
      referer: opts.referer ?? "https://www.snapchat.com/",
      accept: "*/*",
    },
    body: reqBytes.buffer.slice(reqBytes.byteOffset, reqBytes.byteOffset + reqBytes.byteLength) as ArrayBuffer,
  });

  let resp = await send(opts.bearer);
  if (resp.status === 401 && opts.refreshBearer) {
    const fresh = await opts.refreshBearer();
    if (fresh) resp = await send(fresh);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (resp.status !== 200) {
    throw new Error(`search/search HTTP ${resp.status}: ${new TextDecoder().decode(buf).slice(0, 200)}`);
  }
  return parseSearchResponse(buf);
}

/**
 * Parse the search response into a flat list of User objects.
 *
 * Response shape:
 *   { 1: { 1: string sectionName ("Add Friends", "Friends", …),
 *          3 (repeated): { 13: { 1: int, 2: string uuid },
 *                          2: { 1: string uuid, 2: string displayName,
 *                               3: string username, ...} } } }
 *
 * UUIDs are encoded as strings (hyphenated), not bytes16. We extract
 * users from each section's `field 3` repeated entries.
 */
function parseSearchResponse(buf: Uint8Array): User[] {
  const users: Map<string, User> = new Map();
  const top = new ProtoReader(buf);
  while (top.hasMore()) {
    const tag = top.next();
    if (!tag) break;
    if (tag.field === 1 && tag.wireType === 2) {
      // section
      const section = new ProtoReader(top.bytes());
      while (section.hasMore()) {
        const t = section.next();
        if (!t) break;
        if (t.field === 3 && t.wireType === 2) {
          // result entry
          const u = parseUserEntry(new ProtoReader(section.bytes()));
          if (u) users.set(u.userId, u);
        } else {
          try { section.skip(t.wireType); } catch { break; }
        }
      }
    } else {
      try { top.skip(tag.wireType); } catch { break; }
    }
  }
  return Array.from(users.values());
}

function parseUserEntry(r: ProtoReader): User | null {
  // Look for field 2 (the user metadata sub-message).
  while (r.hasMore()) {
    const tag = r.next();
    if (!tag) break;
    if (tag.field === 2 && tag.wireType === 2) {
      return parseUserMetadata(new ProtoReader(r.bytes()));
    }
    try { r.skip(tag.wireType); } catch { return null; }
  }
  return null;
}

function parseUserMetadata(r: ProtoReader): User | null {
  let userId: string | undefined;
  let displayName: string | undefined;
  let username: string | undefined;
  while (r.hasMore()) {
    const tag = r.next();
    if (!tag) break;
    if (tag.field === 1 && tag.wireType === 2) userId = new TextDecoder().decode(r.bytes());
    else if (tag.field === 2 && tag.wireType === 2) displayName = new TextDecoder().decode(r.bytes());
    else if (tag.field === 3 && tag.wireType === 2) username = new TextDecoder().decode(r.bytes());
    else {
      try { r.skip(tag.wireType); } catch { break; }
    }
  }
  if (userId && username) return new User(userId, username, displayName);
  return null;
}

// Re-export for tree-shaking parity (was used by the old heuristic walker).
export { bytesToUuid };
