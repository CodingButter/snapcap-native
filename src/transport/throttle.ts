/**
 * Optional opt-in HTTP throttling for the SDK.
 *
 * @remarks
 * **Why throttling exists at all.** Browsers naturally throttle outbound
 * requests via human pacing — clicks, typing debounce, scroll-stop, mount
 * lifecycle. An automated SDK has none of that. Back-to-back mutations look
 * like spam to Snap's anti-fraud, and we've seen accounts get captcha'd or
 * soft-blocked when test suites or scripts hammer the API. Throttling
 * restores human-cadence pacing.
 *
 * Default behavior (no throttle config) is a pure pass-through — zero
 * overhead, no surprise behavior for consumers who want to manage their own
 * pacing or know their workload is naturally low-volume.
 *
 * **Two modes.** The SDK supports two throttling modes via the `throttle`
 * constructor option, which accepts EITHER a {@link ThrottleConfig}
 * (per-instance) OR a pre-built {@link ThrottleGate} (shared across
 * instances):
 *
 * - **Per-instance** (single tenant, OR low-volume multi-tenant). Each
 *   `SnapcapClient` gets its own throttle state. Two clients each throttling
 *   at "1500ms between AddFriends" can each fire AddFriends at the same
 *   instant — Snap sees 2 calls in 0ms. Fine when N is small (1-2 clients)
 *   or your workload is naturally bursty/low-volume. Anti-spam math:
 *   aggregate rate = N × per-instance-rate.
 *
 * - **Shared** (multi-tenant runners — recommended for N > 2). All clients
 *   coordinate through a single {@link ThrottleGate} built via
 *   {@link createSharedThrottle}. Aggregate rate respects the rules
 *   regardless of N. Trade-off: one slow tenant's throttle wait blocks all
 *   others on the same rule. For a 100-tenant runner where one tenant's
 *   `add()` is queued, the next 99 `add()`s wait ~1500ms × 99 in the worst
 *   case. If you need different rates per tenant, build multiple shared
 *   gates and group clients by gate.
 *
 * **Wire-level placement.** The gate is awaited once per actual wire
 * request, inside the sandbox fetch + XHR shims (the I/O boundary). Same
 * point of control whether the consumer chose per-instance or shared mode —
 * the only difference is whether the gate's state is owned by one Sandbox
 * or shared across many.
 *
 * @example
 * Per-instance throttling — each `SnapcapClient` paces itself:
 *
 * ```ts
 * import { SnapcapClient, RECOMMENDED_THROTTLE_RULES } from "@snapcap/native";
 *
 * const client = new SnapcapClient({
 *   dataStore, username, password,
 *   throttle: { rules: RECOMMENDED_THROTTLE_RULES },
 * });
 * ```
 *
 * @example
 * Shared throttling — coordinate across many clients in one process:
 *
 * ```ts
 * import {
 *   SnapcapClient, createSharedThrottle, RECOMMENDED_THROTTLE_RULES,
 * } from "@snapcap/native";
 *
 * const sharedGate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
 * const clients = users.map(u => new SnapcapClient({
 *   dataStore: u.dataStore, username: u.name, password: u.pw,
 *   throttle: sharedGate,
 * }));
 * await Promise.all(clients.map(c => c.authenticate()));
 * ```
 *
 * @see {@link RECOMMENDED_THROTTLE_RULES}
 * @see {@link createSharedThrottle}
 * @see {@link ThrottleConfig}
 * @see {@link ThrottleRule}
 */

/**
 * Function shape that throttles outbound requests. Awaited once per wire
 * request, immediately before the SDK calls into the underlying fetch /
 * XHR layer.
 *
 * @param url - The destination URL of the imminent request. Used to match
 *   {@link ThrottleRule.match} patterns. Implementations should resolve
 *   immediately for unmatched URLs.
 * @returns A promise that resolves once the request is allowed to proceed.
 *
 * @remarks
 * Pass a {@link ThrottleConfig} to a `SnapcapClient` for per-instance
 * pacing, OR build a shared gate via {@link createSharedThrottle} and pass
 * it to every client when coordinating across many tenants in one process.
 *
 * @see {@link createSharedThrottle}
 */
export type ThrottleGate = (url: string) => Promise<void>;

/**
 * One throttle rule. Matches outbound URLs and gates them at a minimum
 * inter-call interval, with optional burst headroom.
 *
 * @remarks
 * First-match wins inside a {@link ThrottleConfig.rules} array — order
 * rules from most-specific to least-specific.
 *
 * @see {@link RECOMMENDED_THROTTLE_RULES}
 * @see {@link ThrottleConfig}
 */
export type ThrottleRule = {
  /** URL substring or regex. Substring match is case-sensitive. */
  match: string | RegExp;
  /** Floor between consecutive matching requests, in milliseconds. */
  minIntervalMs: number;
  /**
   * Optional burst capacity — N requests can fire freely before the floor
   * kicks in. Useful for batched fetches (e.g. `publicInfo` lookups).
   * Defaults to `0` (every request enforces the floor).
   */
  burst?: number;
};

/**
 * Throttle configuration accepted by `SnapcapClient`'s `throttle` option.
 *
 * @remarks
 * Pass directly for per-instance throttling, or wrap with
 * {@link createSharedThrottle} for cross-instance coordination.
 *
 * @see {@link RECOMMENDED_THROTTLE_RULES} — curated starter rules
 * @see {@link createSharedThrottle}
 */
export type ThrottleConfig = {
  /**
   * Ordered list of rules. First-match wins per outbound URL — order
   * specific rules before general ones.
   */
  rules: ThrottleRule[];
};

/**
 * Recommended starter rules tuned for human-cadence anti-spam friendliness
 * against Snap's web endpoints.
 *
 * @remarks
 * Each entry is calibrated to what a real human user would plausibly do:
 *
 * - **Mutations** (`/JzFriendAction/`, `/FriendRequests/`) — `1500ms`
 *   floor. Humans don't add or unfriend at sub-second cadence.
 * - **Friend roster sync** (`/AtlasGw/SyncFriendData`) — `5000ms` floor.
 *   Snap rate-limits sustained roster polling aggressively.
 * - **Public-info lookups** (`/AtlasGw/GetSnapchatterPublicInfo`) — `100ms`
 *   floor with a `burst: 10` allowance, modelling the in-app prefetch
 *   behaviour for chat-row avatars and friend-grid hydration.
 * - **Search** (`/search/search`) — `300ms` floor, modelling debounced
 *   typing in the browser search box.
 *
 * Consumers opt in by importing this and passing it as
 * `throttle: { rules: RECOMMENDED_THROTTLE_RULES }` (per-instance) or
 * `throttle: createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES })`
 * (shared across instances).
 *
 * @example
 * ```ts
 * import { SnapcapClient, RECOMMENDED_THROTTLE_RULES } from "@snapcap/native";
 * const client = new SnapcapClient({
 *   dataStore, username, password,
 *   throttle: { rules: RECOMMENDED_THROTTLE_RULES },
 * });
 * ```
 *
 * @see {@link createSharedThrottle}
 * @see {@link ThrottleRule}
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
 * Build a throttle gate function from a config. Returns a no-op when the
 * config is undefined or has no rules — zero perf cost.
 *
 * @internal
 * Public consumers should use {@link createSharedThrottle} (for
 * cross-instance coordination) or just pass a {@link ThrottleConfig}
 * directly to `SnapcapClient` (for per-instance throttling). This raw
 * builder is consumed by `Sandbox` to materialize a per-instance gate from
 * `opts.throttle`.
 *
 * @param config - Optional throttle config. When omitted or empty, the
 *   returned gate is a synchronous no-op.
 * @returns A {@link ThrottleGate} that awaits the per-rule floor before
 *   resolving for each matching URL. Token-bucket per rule: each matched URL
 *   waits until the floor since the last fire of that rule has elapsed.
 *   Burst lets the first N fire freely before the floor kicks in.
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
 * Build a SHARED {@link ThrottleGate} for use across multiple
 * `SnapcapClient` instances in the same process.
 *
 * @remarks
 * Pass the returned gate as `throttle: gate` into each client's constructor
 * — all clients will await the same internal state, so the aggregate request
 * rate respects the configured rules regardless of how many clients are
 * coordinating.
 *
 * This is the multi-tenant anti-spam pattern. The in-process multi-instance
 * architecture makes it possible — process-per-instance deployments would
 * require external coordination (file locks, network coordinator, shared
 * memory) which is genuine pain.
 *
 * @param config - The throttle config (rules) to enforce across all clients
 *   that share the returned gate.
 * @returns A {@link ThrottleGate} that can be passed into every
 *   `SnapcapClient`'s `throttle` constructor option.
 *
 * @example
 * ```ts
 * const gate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });
 * const clients = tenants.map(t => new SnapcapClient({
 *   dataStore: t.store, username: t.name, password: t.pw,
 *   throttle: gate,
 * }));
 * ```
 *
 * @see {@link RECOMMENDED_THROTTLE_RULES}
 * @see {@link ThrottleConfig}
 */
export function createSharedThrottle(config: ThrottleConfig): ThrottleGate {
  return createThrottle(config);
}
