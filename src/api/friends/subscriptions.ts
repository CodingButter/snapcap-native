/**
 * Subscription bridges — wire the bundle's user slice into the Friends
 * event bus.
 *
 * Two bridge families:
 *   - `change` — full-snapshot fan-out, distinct shape, owns its own
 *     bridge. Per-subscriber install (matches existing semantics).
 *   - The five diff-style events — share ONE persistent watcher per
 *     Friends instance via the graph-diff bridge. Subscribing
 *     just registers on the bus; the watcher (lazily spun up on the
 *     first such subscription) does the diff + multi-event fan-out.
 *
 * Stateless free functions — they take the per-instance `events` bus +
 * `getCtx` so the {@link Friends} class can keep its private fields
 * (`#events`, `#graphDiffInstalled`) hidden while delegating the bridge
 * mechanics out.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import { subscribeUserSlice, userSlice, userSliceFrom } from "../../bundle/register/index.ts";
import type {
  ChatState,
  IncomingFriendRequestRecord,
  PublicUserRecord,
  UserSlice,
} from "../../bundle/types/index.ts";
import type { TypedEventBus } from "../../lib/typed-event-bus.ts";
import { makeFriend, makeReceivedRequest } from "./mappers.ts";
import {
  buildGraphSnapshot,
  buildSnapshot,
  saveGraphCacheGuarded,
} from "./snapshot-builders.ts";
import { type FriendGraphSnapshot, diffGraph, loadGraphCache } from "./graph-cache.ts";
import type { FriendsEvents } from "./events.ts";

/**
 * Bridge — subscribe to the user slice and emit a `change` event on
 * every selector tick. Composite selector watches mutuals, incoming
 * requests, and outgoing requests; coarse identity-and-size equality
 * (the bundle mutates the user slice in-place via Immer, so size
 * catches in-place mutations and a reference flip implies a fresh
 * slice replacement).
 *
 * Bails if `signal.aborted` after ctx lands; otherwise wires the
 * slice-side unsubscribe to fire on `signal.abort` so the bridge tears
 * down when the subscription dies.
 *
 * @internal
 */
export async function bridgeUserSliceToChange(
  getCtx: () => Promise<ClientContext>,
  events: TypedEventBus<FriendsEvents>,
  signal: AbortSignal,
): Promise<void> {
  type Composite = {
    m: string[] | undefined;
    i: Map<string, IncomingFriendRequestRecord> | undefined;
    o: string[] | undefined;
  };
  const ctx = await getCtx();
  if (signal.aborted) return;
  const unsub = subscribeUserSlice<Composite>(
    ctx.sandbox,
    (u: UserSlice) => ({
      m: u.mutuallyConfirmedFriendIds,
      i: u.incomingFriendRequests,
      o: u.outgoingFriendRequestIds,
    }),
    (a: Composite, b: Composite) => {
      // Equal iff every slot is reference-identical AND size-identical.
      if (a.m !== b.m) return false;
      if (a.i !== b.i) return false;
      if (a.o !== b.o) return false;
      if ((a.m?.length ?? 0) !== (b.m?.length ?? 0)) return false;
      if ((a.i?.size ?? 0) !== (b.i?.size ?? 0)) return false;
      if ((a.o?.length ?? 0) !== (b.o?.length ?? 0)) return false;
      return true;
    },
    (_curr: Composite, _prev: Composite, state: ChatState) => {
      events.emit("change", buildSnapshot(userSliceFrom(state)));
    },
  );
  signal.addEventListener("abort", unsub, { once: true });
}

/**
 * Bridge — the unified graph-diff watcher behind the five diff-style
 * events (`friend:added`, `friend:removed`, `request:received`,
 * `request:cancelled`, `request:accepted`).
 *
 * Lifecycle:
 *   1. Loads the persisted snapshot from `ctx.dataStore`. If present,
 *      use it as `prior` so the first tick replays any deltas that
 *      occurred while the SDK was offline. If absent (first-ever
 *      run), seed `prior` from the current slice — no replay, just
 *      establish a baseline.
 *   2. Subscribes to the composite slot via `subscribeUserSlice`.
 *   3. On every selector tick: build `current`, diff against `prior`,
 *      fan out per-id events, persist `current`, advance `prior`.
 *
 * Lives for the lifetime of the Friends instance — see the
 * `installGraphDiffBridge` doc on the manager for the rationale.
 *
 * @internal
 */
export async function bridgeUserSliceToGraphDiff(
  getCtx: () => Promise<ClientContext>,
  events: TypedEventBus<FriendsEvents>,
): Promise<void> {
  type Composite = {
    m: string[] | undefined;
    i: Map<string, IncomingFriendRequestRecord> | undefined;
    o: string[] | undefined;
  };

  const ctx = await getCtx();

  // Snapshot shape comes from the module-level `buildGraphSnapshot`
  // helper — same projection used by the read-path persistence
  // (`persistGraphSnapshotFrom`). Materialization (publicUsers /
  // IncomingFriendRequestRecord lookups) happens at emit time using
  // the live slice values, NOT the persisted snapshot.

  // Seed prior. Cache hit → replay offline deltas. Cache miss →
  // establish baseline silently (first-ever run, no replay).
  const cached = await loadGraphCache(ctx.dataStore);
  let prior: FriendGraphSnapshot;
  if (cached) {
    prior = cached;
  } else {
    prior = buildGraphSnapshot(userSlice(ctx.sandbox));
    // Persist the baseline so a crash before the first real tick
    // doesn't lose it; subsequent runs will diff against this rather
    // than treating the whole graph as "new".
    await saveGraphCacheGuarded(ctx.dataStore, prior);
  }

  // Run the first diff synchronously so offline-window deltas fan
  // out immediately rather than waiting for the next bundle tick
  // (which may never come if no `refresh()` is called).
  const fanOut = (current: FriendGraphSnapshot, liveSlice: UserSlice): void => {
    const { added, removed, acceptedRequests } = diffGraph(prior, current);
    const publicUsers = liveSlice.publicUsers ?? new Map<string, PublicUserRecord>();
    const incomingMap = liveSlice.incomingFriendRequests ??
      new Map<string, IncomingFriendRequestRecord>();

    // Fan out one event per id per slot. Wrap each emit in try/catch
    // so a misbehaving consumer of any one event doesn't tear down
    // the watcher or starve siblings.
    for (const id of added.mutuals) {
      try { events.emit("friend:added", makeFriend(id, publicUsers)); }
      catch { /* swallow consumer errors */ }
    }
    for (const id of removed.mutuals) {
      try { events.emit("friend:removed", id); }
      catch { /* swallow consumer errors */ }
    }
    for (const id of added.incoming) {
      const rec = incomingMap.get(id);
      if (!rec) continue;
      try { events.emit("request:received", makeReceivedRequest(id, rec)); }
      catch { /* swallow consumer errors */ }
    }
    for (const id of removed.incoming) {
      try { events.emit("request:cancelled", id); }
      catch { /* swallow consumer errors */ }
    }
    for (const id of acceptedRequests) {
      try { events.emit("request:accepted", id); }
      catch { /* swallow consumer errors */ }
    }
  };

  // Initial replay against the persisted snapshot (no-op when cache
  // was missing — `prior` was just seeded from the live slice, diff
  // is empty by construction).
  {
    const liveSlice = userSlice(ctx.sandbox);
    const initial = buildGraphSnapshot(liveSlice);
    fanOut(initial, liveSlice);
    prior = initial;
    await saveGraphCacheGuarded(ctx.dataStore, prior);
  }

  subscribeUserSlice<Composite>(
    ctx.sandbox,
    (u: UserSlice) => ({
      m: u.mutuallyConfirmedFriendIds,
      i: u.incomingFriendRequests,
      o: u.outgoingFriendRequestIds,
    }),
    (a: Composite, b: Composite) => {
      // Coarse identity-and-size equality — same rationale as the
      // change bridge. Immer mutates in place; size catches the
      // common cases without forcing a per-id walk on every tick.
      if (a.m !== b.m) return false;
      if (a.i !== b.i) return false;
      if (a.o !== b.o) return false;
      if ((a.m?.length ?? 0) !== (b.m?.length ?? 0)) return false;
      if ((a.i?.size ?? 0) !== (b.i?.size ?? 0)) return false;
      if ((a.o?.length ?? 0) !== (b.o?.length ?? 0)) return false;
      return true;
    },
    (_curr, _prev, state: ChatState) => {
      const liveSlice = userSliceFrom(state);
      const current = buildGraphSnapshot(liveSlice);
      fanOut(current, liveSlice);
      prior = current;
      // Fire-and-forget; persistence failures are swallowed inside
      // saveGraphCache so they can't break the live emit fan-out.
      // Guarded variant avoids clobbering a populated cache with an
      // empty snapshot during an interim user-slice tick.
      void saveGraphCacheGuarded(ctx.dataStore, current);
    },
  );
  // Note: install-once-per-instance — no signal-based teardown. The
  // watcher lives for the Friends instance's lifetime by design (see
  // the `installGraphDiffBridge` method on the manager).
}
