/**
 * Multi-account selection + usage tracking for test scripts.
 *
 * Reads `.snapcap-smoke.json` to get the account roster (with status +
 * lastRequestAt timestamps), picks the account least likely to trip
 * Snap's anti-abuse, and persists the "used now" timestamp so the next
 * script picks a different one.
 *
 * Selection priority:
 *   1. SNAPCAP_ACCOUNT=username env var → exact match (skips all filters,
 *      lets you force a specific account regardless of status)
 *   2. Otherwise: filter out accounts with `soft-blocked` or `hard-blocked`
 *      status, then sort by `lastRequestAt` ascending (oldest / never-used
 *      first), return the first.
 *
 * Why per-script timestamping (not per-RPC): anti-abuse cares about
 * traffic bursts. If a script runs many calls in one session, what
 * matters is the gap to the next session, not the gap between calls.
 * Per-script-run granularity is the sweet spot of accuracy + simplicity.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Account status:
 * - `accepted` — usable; picker may select it.
 * - `soft-blocked` — temporarily unavailable (rate limit, IP throttle).
 *   Will recover on its own with time. Picker skips; you can manually
 *   flip back to `accepted` after the cooldown window.
 * - `hard-blocked` — needs human intervention (captcha challenge,
 *   account suspended, password change). Picker skips until manually
 *   cleared.
 */
export type AccountStatus = "accepted" | "soft-blocked" | "hard-blocked";

export type Account = {
  username: string;
  password: string;
  authPath: string;
  status?: AccountStatus;
  /** ISO timestamp of the last script run that used this account. */
  lastRequestAt?: string;
};

export type SmokeConfig = {
  accounts?: Account[];
  /** Top-level shape (legacy / single-account default). */
  username?: string;
  password?: string;
  authPath?: string;
};

const SDK_ROOT = join(import.meta.dir, "..", "..");
const CONFIG_PATH = join(SDK_ROOT, ".snapcap-smoke.json");

const BAD_STATUSES = new Set<AccountStatus>(["soft-blocked", "hard-blocked"]);

function loadConfig(): SmokeConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as SmokeConfig;
}

function saveConfig(cfg: SmokeConfig): void {
  // Preserve trailing newline for editor cleanliness.
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Pick an account. Honors `SNAPCAP_ACCOUNT=username` env override; otherwise
 * picks the least-recently-used non-blocked account from the roster. Falls
 * back to the top-level legacy shape if `accounts[]` is absent.
 */
export function pickAccount(): Account {
  const cfg = loadConfig();
  const override = process.env.SNAPCAP_ACCOUNT;

  if (override && cfg.accounts) {
    const exact = cfg.accounts.find((a) => a.username === override);
    if (exact) return exact;
    throw new Error(`SNAPCAP_ACCOUNT=${override} not in accounts[]`);
  }

  if (!cfg.accounts || cfg.accounts.length === 0) {
    if (!cfg.username || !cfg.password) {
      throw new Error("`.snapcap-smoke.json` has no accounts[] and no top-level username/password");
    }
    return {
      username: cfg.username,
      password: cfg.password,
      authPath: cfg.authPath ?? ".tmp/auth/auth.json",
    };
  }

  const eligible = cfg.accounts.filter((a) => !a.status || !BAD_STATUSES.has(a.status));
  if (eligible.length === 0) {
    throw new Error(
      `no eligible accounts — all ${cfg.accounts.length} are blocked. ` +
      `Override with SNAPCAP_ACCOUNT=name, clear status fields, or wait.`,
    );
  }

  // Oldest lastRequestAt first; treat undefined / null as oldest-possible.
  eligible.sort((a, b) => {
    const at = a.lastRequestAt ? Date.parse(a.lastRequestAt) : 0;
    const bt = b.lastRequestAt ? Date.parse(b.lastRequestAt) : 0;
    return at - bt;
  });

  return eligible[0]!;
}

/**
 * Stamp the chosen account's `lastRequestAt` with the current time so the
 * next `pickAccount()` picks a different one. Updates the JSON in place.
 */
export function markAccountUsed(username: string): void {
  const cfg = loadConfig();
  if (!cfg.accounts) return;
  const acct = cfg.accounts.find((a) => a.username === username);
  if (!acct) return;
  acct.lastRequestAt = new Date().toISOString();
  saveConfig(cfg);
}

/**
 * Update an account's status (e.g. mark `hard-blocked` after a captcha
 * challenge, or `soft-blocked` on a rate-limit error). Persists to disk
 * so future `pickAccount()` calls skip it until manually flipped back to
 * `accepted`.
 */
export function markAccountStatus(username: string, status: Account["status"]): void {
  const cfg = loadConfig();
  if (!cfg.accounts) return;
  const acct = cfg.accounts.find((a) => a.username === username);
  if (!acct) return;
  acct.status = status;
  saveConfig(cfg);
}

/** Convenience: SDK-root-relative join. */
export function sdkPath(...segments: string[]): string {
  return join(SDK_ROOT, ...segments);
}
