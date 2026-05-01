/**
 * Optional opt-in HTTP throttling for the SDK.
 *
 * Browsers naturally throttle outbound requests via human pacing (clicks,
 * typing debounce, etc.). An automated SDK has none of that — back-to-back
 * mutations look like spam to Snap's anti-fraud, and we've seen accounts
 * get captcha'd or soft-blocked when test suites hammer the API.
 *
 * This module exposes a configurable per-URL-pattern throttle that the SDK
 * consumer can opt into. Default behavior (no config passed) is a pure
 * pass-through — zero overhead, no surprise behavior for consumers who
 * just want browser-like cadence.
 *
 * Wiring lives in `transport/native-fetch.ts` — the single chokepoint
 * for ALL host-realm HTTP, so throttling happens exactly once per wire
 * request regardless of which shim (`fetch.ts` / `xml-http-request.ts`)
 * issued it.
 */
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
 * passing as `throttle: { rules: RECOMMENDED_THROTTLE_RULES }`.
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
 */
export function createThrottle(config?: ThrottleConfig): (url: string) => Promise<void> {
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
