/**
 * Friend-graph snapshot cache — persisted view of the three friend-graph
 * id-sets so the diff-style {@link Friends} events can detect deltas that
 * occurred while the SDK was offline.
 *
 * @remarks
 * The cache stores ONLY id-sets (not richer envelopes like
 * `IncomingFriendRequestRecord`) because the diff-style events fan out
 * one id at a time and the bundle's `publicUsers` cache / current
 * `incomingFriendRequests` Map already carries the materialization data
 * the bridge needs to build the consumer-shape payload at emit time.
 *
 * Encoding: plain JSON over `TextEncoder`/`TextDecoder` — small (a few
 * KB even for chunky friend graphs), and JSON survives bundle / SDK
 * version drift better than any binary tagged format.
 *
 * @internal
 */
import type { DataStore } from "../storage/data-store.ts";

/**
 * Persisted snapshot of the three id-sets that drive diff-style
 * {@link Friends} events.
 *
 * @internal
 */
export interface FriendGraphSnapshot {
  /** Hyphenated UUIDs of mutually-confirmed friends. */
  mutuals: string[];
  /** Hyphenated UUIDs of pending outgoing friend requests. */
  outgoing: string[];
  /** Hyphenated UUIDs of pending incoming friend requests. */
  incoming: string[];
  /** Wall-clock timestamp (ms) when the snapshot was last persisted. */
  ts: number;
}

/**
 * DataStore key the snapshot is persisted under. Single key per logical
 * client — the cache is global to the Friends manager, not per-event.
 *
 * Carries the bundle-localStorage `local_` prefix even though the SDK
 * writes it directly: keeps key-naming uniform with the bundle's other
 * persisted slots (`local_rwk_blob`, `local_uds.*`, `local_snapcap_self`)
 * so a future migration to the actual localStorage shim is just a route
 * change with no rename. Old key (`snapcap:friend_graph_cache`) is migrated
 * lazily on the first {@link loadGraphCache} call — see implementation.
 *
 * @internal
 */
export const FRIEND_GRAPH_CACHE_KEY = "local_snapcap:friend_graph_cache";

/**
 * Legacy DataStore key the snapshot was persisted under prior to the
 * `local_` prefix migration. Used by {@link loadGraphCache} for one-shot
 * read + copy + delete on first run after the rename. Not written to.
 *
 * @internal
 */
export const FRIEND_GRAPH_CACHE_KEY_LEGACY = "snapcap:friend_graph_cache";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Read the persisted snapshot from `ds`.
 *
 * Returns `undefined` when the cache key is absent (first-ever run, or
 * after a manual wipe) OR when the stored bytes can't be decoded as a
 * snapshot. Callers should treat both cases the same: skip diff replay
 * on this tick and seed `prior` from `current`.
 *
 * @internal
 */
export async function loadGraphCache(
  ds: DataStore,
): Promise<FriendGraphSnapshot | undefined> {
  let raw: Uint8Array | undefined;
  try {
    raw = await ds.get(FRIEND_GRAPH_CACHE_KEY);
  } catch {
    return undefined;
  }
  // Lazy legacy-key migration: if the new prefixed key is missing AND a
  // pre-migration cache exists under the old key, copy it forward and
  // delete the old slot. Backward-compatible single-shot.
  if (!raw || raw.byteLength === 0) {
    try {
      const legacy = await ds.get(FRIEND_GRAPH_CACHE_KEY_LEGACY);
      if (legacy && legacy.byteLength > 0) {
        try { await ds.set(FRIEND_GRAPH_CACHE_KEY, legacy); } catch { /* tolerate */ }
        try { await ds.delete(FRIEND_GRAPH_CACHE_KEY_LEGACY); } catch { /* tolerate */ }
        raw = legacy;
      }
    } catch { /* tolerate */ }
  }
  if (!raw || raw.byteLength === 0) return undefined;
  try {
    const obj = JSON.parse(decoder.decode(raw)) as Partial<FriendGraphSnapshot>;
    if (
      !Array.isArray(obj.mutuals) ||
      !Array.isArray(obj.outgoing) ||
      !Array.isArray(obj.incoming)
    ) return undefined;
    return {
      mutuals: obj.mutuals.filter((x): x is string => typeof x === "string"),
      outgoing: obj.outgoing.filter((x): x is string => typeof x === "string"),
      incoming: obj.incoming.filter((x): x is string => typeof x === "string"),
      ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist `snap` into `ds` under {@link FRIEND_GRAPH_CACHE_KEY}.
 *
 * Best-effort durable: errors are swallowed so a failing flush doesn't
 * break the live event fan-out. Subsequent ticks will overwrite the same
 * key and recover.
 *
 * @internal
 */
export async function saveGraphCache(
  ds: DataStore,
  snap: FriendGraphSnapshot,
): Promise<void> {
  try {
    await ds.set(FRIEND_GRAPH_CACHE_KEY, encoder.encode(JSON.stringify(snap)));
  } catch {
    /* persistence failures shouldn't poison live emit fan-out */
  }
}

/**
 * `true` iff `s` carries no ids in any of the three slots. Used by the
 * persist call sites to avoid clobbering a previously-good cache when the
 * bundle's `state.user` slice hasn't fully synced yet (the empty-snapshot
 * tick during boot was previously wiping the cache between runs).
 *
 * @internal
 */
export function isEmptyGraphSnapshot(s: FriendGraphSnapshot): boolean {
  return s.mutuals.length === 0 && s.outgoing.length === 0 && s.incoming.length === 0;
}

/**
 * Diff `current` against `prior`. Returns:
 *
 *  - `added.<slot>` — ids in `current.<slot>` that were NOT in
 *    `prior.<slot>`.
 *  - `removed.<slot>` — ids in `prior.<slot>` that are NO LONGER in
 *    `current.<slot>`.
 *  - `acceptedRequests` — cross-slot signal: ids that were in
 *    `prior.outgoing` AND are now in `current.mutuals`. The recipient
 *    accepted our outbound request, the bundle promoted them to
 *    mutuals, and the outgoing entry vanished — all on the same tick.
 *
 * Note: an accepted request also produces an entry in
 * `added.mutuals` for the same id; the {@link Friends} bridge fans out
 * BOTH `friend:added` and `request:accepted` for those ids
 * intentionally — the events carry distinct semantics.
 *
 * @internal
 */
export function diffGraph(
  prior: FriendGraphSnapshot,
  current: FriendGraphSnapshot,
): {
  added: { mutuals: string[]; outgoing: string[]; incoming: string[] };
  removed: { mutuals: string[]; outgoing: string[]; incoming: string[] };
  acceptedRequests: string[];
} {
  const priorMutuals = new Set(prior.mutuals);
  const priorOutgoing = new Set(prior.outgoing);
  const priorIncoming = new Set(prior.incoming);
  const currMutuals = new Set(current.mutuals);
  const currOutgoing = new Set(current.outgoing);
  const currIncoming = new Set(current.incoming);

  const added = {
    mutuals: current.mutuals.filter((id) => !priorMutuals.has(id)),
    outgoing: current.outgoing.filter((id) => !priorOutgoing.has(id)),
    incoming: current.incoming.filter((id) => !priorIncoming.has(id)),
  };
  const removed = {
    mutuals: prior.mutuals.filter((id) => !currMutuals.has(id)),
    outgoing: prior.outgoing.filter((id) => !currOutgoing.has(id)),
    incoming: prior.incoming.filter((id) => !currIncoming.has(id)),
  };
  const acceptedRequests = prior.outgoing.filter(
    (id) => currMutuals.has(id),
  );
  return { added, removed, acceptedRequests };
}
