/**
 * Optional opt-in HTTP throttling for the SDK.
 *
 * # Why throttling exists at all
 *
 * Browsers naturally throttle outbound requests via human pacing — clicks,
 * typing debounce, scroll-stop, mount lifecycle. An automated SDK has none
 * of that. Back-to-back mutations look like spam to Snap's anti-fraud, and
 * we've seen accounts get captcha'd or soft-blocked when test suites or
 * scripts hammer the API. Throttling restores human-cadence pacing.
 *
 * Default behavior (no throttle config) is a pure pass-through — zero
 * overhead, no surprise behavior for consumers who want to manage their
 * own pacing or know their workload is naturally low-volume.
 *
 * # Two modes — pick the one that matches your deployment
 *
 * The SDK supports two throttling modes via the `throttle` constructor
 * option, which accepts EITHER a `ThrottleConfig` (per-instance) OR a
 * pre-built `ThrottleGate` (shared across instances):
 *
 * ## Per-instance (single tenant, OR low-volume multi-tenant)
 *
 *   ```ts
 *   import { SnapcapClient, RECOMMENDED_THROTTLE_RULES } from "@snapcap/native";
 *   const client = new SnapcapClient({
 *     dataStore, username, password,
 *     throttle: { rules: RECOMMENDED_THROTTLE_RULES },
 *   });
 *   ```
 *
 *   Each `SnapcapClient` gets its own throttle state. Two clients each
 *   throttling at "1500ms between AddFriends" can each fire AddFriends at
 *   the same instant — Snap sees 2 calls in 0ms. Fine when N is small
 *   (1-2 clients) or your workload is naturally bursty/low-volume.
 *
 *   **Anti-spam math:** aggregate rate = N × per-instance-rate. With
 *   recommended rules (1500ms / mutation), 5 clients = 5 mutations per
 *   1500ms aggregate, which Snap may flag as suspicious.
 *
 * ## Shared (multi-tenant runners — recommended for N > 2)
 *
 *   ```ts
 *   import {
 *     SnapcapClient, createSharedThrottle, RECOMMENDED_THROTTLE_RULES
 *   } from "@snapcap/native";
 *
 *   // Build ONE gate; all clients await it before issuing a request.
 *   const sharedGate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
 *
 *   const clients = users.map(u => new SnapcapClient({
 *     dataStore: u.dataStore, username: u.name, password: u.pw,
 *     throttle: sharedGate,   // pass the gate function directly
 *   }));
 *   await Promise.all(clients.map(c => c.authenticate()));
 *   ```
 *
 *   All clients coordinate. Aggregate rate respects the rules regardless
 *   of N. Anti-spam math: aggregate rate = per-instance-rate (constant in N).
 *
 *   **Trade-off:** one slow tenant's throttle wait blocks all others on
 *   the same rule. For a 100-tenant runner where one tenant's add() is
 *   queued, the next 99 add()s wait ~1500ms × 99 in the worst case. If
 *   you need different rates per tenant, build multiple shared gates and
 *   group clients by gate.
 *
 * # Wire-level placement
 *
 * The gate is awaited once per actual wire request, inside the sandbox
 * fetch + XHR shims (the I/O boundary). Same point of control whether
 * the consumer chose per-instance or shared mode — the only difference
 * is whether the gate's state is owned by one Sandbox or shared across
 * many.
 *
 * Default off when nothing is passed: zero perf, no surprise.
 */

/** Function shape that throttles outbound requests. Awaited once per wire request. */
export type ThrottleGate = (url: string) => Promise<void>;

export type ThrottleRule = {
  /** URL substring or regex. Substring match is case-sensitive. */
  match: string | RegExp;
  /** Floor between consecutive matching requests, in milliseconds. */
  minIntervalMs: number;
  /**
   * Optional burst capacity — N requests can fire freely before the
   * floor kicks in. Useful for batched fetches (e.g. publicInfo lookups).
   * Defaults to 0 (every request enforces the floor).
   */
  burst?: number;
};

export type ThrottleConfig = {
  rules: ThrottleRule[];
};

/**
 * Recommended starter rules. Tuned for human-cadence anti-spam friendliness
 * against Snap's web endpoints. Consumers opt in by importing this and
 * passing as `throttle: { rules: RECOMMENDED_THROTTLE_RULES }` (per-instance)
 * or `throttle: createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES })`
 * (shared across instances).
 */
export const RECOMMENDED_THROTTLE_RULES: ThrottleRule[] = [
  // Mutations — humans don't fire these multiple times per second
  { match: "/JzFriendAction/", minIntervalMs: 1500 },
  { match: "/FriendRequests/", minIntervalMs: 1500 },

  // Reads — usually fine in bursts but Snap rate-limits sustained calls
  { match: "/AtlasGw/SyncFriendData", minIntervalMs: 5000 },
  { match: "/AtlasGw/GetSnapchatterPublicInfo", minIntervalMs: 100, burst: 10 },

  // Search — debounced typing in the browser
  { match: "/search/search", minIntervalMs: 300 },
];

/**
 * Build a throttle gate function from a config. Returns a no-op when
 * config is undefined or has no rules — zero perf cost.
 *
 * Token-bucket per rule: each matched URL waits until the floor since
 * the last fire of that rule has elapsed. Burst lets the first N fire
 * freely before the floor kicks in.
 *
 * Used internally by `Sandbox` to build a per-instance gate from
 * `opts.throttle` when a `ThrottleConfig` is passed. For the shared-
 * across-instances pattern, use the public `createSharedThrottle()`.
 */
export function createThrottle(config?: ThrottleConfig): ThrottleGate {
  if (!config || config.rules.length === 0) return async () => {};
  type State = { rule: ThrottleRule; lastFiredAt: number; burstUsed: number };
  const states: State[] = config.rules.map((rule) => ({ rule, lastFiredAt: 0, burstUsed: 0 }));

  const matches = (url: string, pattern: string | RegExp): boolean => {
    if (typeof pattern === "string") return url.includes(pattern);
    return pattern.test(url);
  };

  return async (url: string): Promise<void> => {
    // First-match wins. Order rules in config so most specific is first.
    const s = states.find((st) => matches(url, st.rule.match));
    if (!s) return;
    if (s.rule.burst !== undefined && s.burstUsed < s.rule.burst) {
      s.burstUsed++;
      s.lastFiredAt = Date.now();
      return;
    }
    const elapsed = Date.now() - s.lastFiredAt;
    const wait = Math.max(0, s.rule.minIntervalMs - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    s.lastFiredAt = Date.now();
  };
}

/**
 * Build a SHARED `ThrottleGate` for use across multiple `SnapcapClient`
 * instances in the same process.
 *
 * Pass the returned gate as `throttle: gate` into each client's
 * constructor — all clients will await the same internal state, so the
 * aggregate request rate respects the configured rules regardless of how
 * many clients are coordinating.
 *
 * This is the multi-tenant anti-spam pattern. The in-process multi-instance
 * architecture makes it possible — process-per-instance deployments would
 * require external coordination (file locks, network coordinator, shared
 * memory) which is genuine pain.
 *
 * @example
 *   const gate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
 *   const clients = tenants.map(t => new SnapcapClient({
 *     dataStore: t.store, username: t.name, password: t.pw,
 *     throttle: gate,
 *   }));
 */
export function createSharedThrottle(config: ThrottleConfig): ThrottleGate {
  return createThrottle(config);
}
