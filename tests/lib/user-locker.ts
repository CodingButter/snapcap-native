/**
 * user-locker.ts — atomic checkout/checkin for test accounts.
 *
 * Lets parallel test runs (e.g. multiple agents in worktrees, multiple
 * Bun test workers) each grab an UNUSED Snap account from the pool
 * without colliding. Each account is a lockable resource — the underlying
 * primitive is `mkdir(.tmp/locks/<username>.lock)` which is atomic on
 * POSIX filesystems.
 *
 * Why we need this: Snap's bearer JWT is session-bound. Two processes
 * authenticating with the same account each refresh the bearer
 * independently → Snap invalidates the previous session on each refresh
 * → both processes infinite-loop into 401 → refresh → 401. The locker
 * guarantees only ONE process uses each account at a time.
 *
 * Layout the locker assumes:
 *   .tmp/configs/<username>.config.json    per-account credentials + fingerprint
 *   .tmp/storage/<username>.json           per-account cached session state
 *   .tmp/locks/<username>.lock/            atomic-mkdir lock dir + pid file
 *
 * All three are gitignored (under `.tmp/`). In agent worktrees, `.tmp/`
 * is symlinked from main, so locks coordinate across worktrees naturally.
 *
 * Public API:
 *   await withLockedUser(async (user) => { ... });
 *
 * The callback receives `{ username, config, storagePath, configPath }`
 * and the lock auto-releases (try/finally) when the callback resolves
 * or throws.
 *
 * @example
 * ```ts
 * import { withLockedUser } from "../lib/user-locker.ts";
 *
 * test("authenticate end-to-end", async () => {
 *   await withLockedUser(async (user) => {
 *     const client = new SnapcapClient({
 *       dataStore: new FileDataStore(user.storagePath),
 *       credentials: { username: user.username, password: user.config.password },
 *       browser: { userAgent: user.config.fingerprint.userAgent },
 *     });
 *     await client.authenticate();
 *     // ... assertions ...
 *   });
 * });
 * ```
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Resolved per-account context handed to a `withLockedUser` callback.
 *
 * Lock release is automatic via `try/finally` inside `withLockedUser` —
 * there's no manual `release()` to call.
 */
export interface LockedUser {
  /** The account username (e.g. "perdyjamie"). */
  readonly username: string;
  /** Absolute path to the per-user config file. */
  readonly configPath: string;
  /** Absolute path to the storage/auth file (pass to FileDataStore). */
  readonly storagePath: string;
  /** Parsed config: credentials + fingerprint + per-user metadata. */
  readonly config: UserConfig;
}

/**
 * Per-user config file shape — one of these per account in `.tmp/configs/`.
 */
export interface UserConfig {
  username: string;
  password: string;
  storagePath: string;
  fingerprint: {
    userAgent: string;
    viewport?: { width: number; height: number };
    timezone?: string;
    locale?: string;
    platform?: string;
  };
}

/**
 * Options for `withLockedUser`.
 */
export interface WithLockedUserOpts {
  /** Try this account first if available. Falls through to others if locked. */
  preferUser?: string;
  /** Wait up to this many ms for an account to free up before failing. Default 0 (fail-fast). */
  waitTimeoutMs?: number;
  /** Polling interval while waiting. Default 500ms. */
  pollIntervalMs?: number;
  /** Override the project root. Default: walk up from CWD to find `.tmp/configs/`. */
  projectRoot?: string;
}

/**
 * Acquire a per-user lock, run the callback with the user's context,
 * release the lock when the callback resolves or throws.
 *
 * Throws if no user is available within `waitTimeoutMs` (default: fail-fast).
 *
 * @example
 * ```ts
 * await withLockedUser(async (user) => {
 *   const client = new SnapcapClient({
 *     dataStore: new FileDataStore(user.storagePath),
 *     credentials: { username: user.username, password: user.config.password },
 *     browser: { userAgent: user.config.fingerprint.userAgent },
 *   });
 *   await client.authenticate();
 * });
 * ```
 */
export async function withLockedUser<T>(
  fn: (user: LockedUser) => Promise<T>,
  opts: WithLockedUserOpts = {},
): Promise<T> {
  const root = opts.projectRoot ?? findProjectRoot();
  const user = await checkout(root, opts);
  try {
    return await fn(user);
  } finally {
    release(root, user.username);
  }
}

/**
 * List the usernames of all configured accounts. Useful for diagnostics
 * or for tests that need to enumerate accounts directly (rare).
 */
export function listConfiguredUsers(projectRoot?: string): string[] {
  const root = projectRoot ?? findProjectRoot();
  return readUsersFromConfigs(root);
}

/**
 * Manual checkout for tests that need lifecycle control beyond a single
 * `withLockedUser` callback (e.g. bun's `beforeAll`/`afterAll`).
 *
 * MUST be paired with `releaseUser` in afterAll/finally — otherwise the
 * lock leaks until the process exits (kernel will still free it then,
 * but parallel runners might block waiting).
 *
 * @example
 * ```ts
 * let user: LockedUser;
 * beforeAll(async () => {
 *   user = await checkoutUser({ preferUser: "perdyjamie" });
 *   client = new SnapcapClient({ ... });
 * });
 * afterAll(() => releaseUser(user));
 * ```
 */
export async function checkoutUser(opts: WithLockedUserOpts = {}): Promise<LockedUser> {
  const root = opts.projectRoot ?? findProjectRoot();
  return checkout(root, opts);
}

/**
 * Release a user previously acquired via `checkoutUser`. Idempotent —
 * safe to call multiple times or on a user that's already been released.
 */
export function releaseUser(user: LockedUser, projectRoot?: string): void {
  const root = projectRoot ?? findProjectRoot();
  release(root, user.username);
}

// ── Internals ──────────────────────────────────────────────────────────

const LOCK_PID_FILENAME = "pid";

function findProjectRoot(): string {
  // Walk up from CWD looking for a directory that contains `.tmp/configs/`.
  // This works whether tests are invoked from the repo root or a sub-dir.
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, ".tmp", "configs"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error(
        "user-locker: could not find a parent directory containing .tmp/configs/. " +
        "Run from the SnapSDK repo root, or pass `projectRoot` explicitly.",
      );
    }
    dir = parent;
  }
}

function readUsersFromConfigs(root: string): string[] {
  const dir = join(root, ".tmp", "configs");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".config.json"))
    .map((f) => f.replace(/\.config\.json$/, ""))
    .sort();
}

function readConfig(root: string, username: string): UserConfig {
  const path = join(root, ".tmp", "configs", `${username}.config.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as UserConfig;
}

async function checkout(root: string, opts: WithLockedUserOpts): Promise<LockedUser> {
  const locksDir = join(root, ".tmp", "locks");
  mkdirSync(locksDir, { recursive: true });

  const users = readUsersFromConfigs(root);
  if (users.length === 0) {
    throw new Error(
      `user-locker: no configs found in ${join(root, ".tmp", "configs")}. ` +
      "Ensure per-user configs exist before checkout.",
    );
  }

  // Sort with preferred user first, if specified.
  const ordered =
    opts.preferUser && users.includes(opts.preferUser)
      ? [opts.preferUser, ...users.filter((u) => u !== opts.preferUser)]
      : users;

  const startTime = Date.now();
  const timeoutMs = opts.waitTimeoutMs ?? 0;
  const pollMs = opts.pollIntervalMs ?? 500;

  while (true) {
    const claimed = tryClaimAny(locksDir, ordered);
    if (claimed) {
      const config = readConfig(root, claimed);
      return {
        username: claimed,
        configPath: join(root, ".tmp", "configs", `${claimed}.config.json`),
        storagePath: join(root, config.storagePath),
        config,
      };
    }

    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(
        `user-locker: no account available (all ${users.length} locked). ` +
        `Pool: ${users.join(", ")}. ` +
        `Pass waitTimeoutMs to wait for one to free up.`,
      );
    }

    await sleep(pollMs);
  }
}

/**
 * Try to atomically claim one of the candidate users. Returns the
 * username we got, or null if all are taken.
 */
function tryClaimAny(locksDir: string, candidates: string[]): string | null {
  for (const username of candidates) {
    const lockDir = join(locksDir, `${username}.lock`);

    // Atomic create: mkdir fails with EEXIST if it already exists.
    try {
      mkdirSync(lockDir);
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        // Someone else has it — but check if owner is alive (stale-lock cleanup).
        if (isStaleLock(lockDir)) {
          // Best-effort cleanup + retry.
          try {
            rmSync(lockDir, { recursive: true, force: true });
            mkdirSync(lockDir);
          } catch {
            continue; // Lost the race; try next user.
          }
        } else {
          continue; // Owner is alive; skip.
        }
      } else {
        throw err;
      }
    }

    // We own the lock — write our PID for liveness checks.
    writeFileSync(join(lockDir, LOCK_PID_FILENAME), String(process.pid), "utf8");
    return username;
  }
  return null;
}

/**
 * A lock is stale if its pid file references a process that no longer
 * exists. `process.kill(pid, 0)` returns silently if the process exists,
 * throws ESRCH if it doesn't.
 */
function isStaleLock(lockDir: string): boolean {
  const pidFile = join(lockDir, LOCK_PID_FILENAME);
  if (!existsSync(pidFile)) {
    // Lock dir without pid file — either mid-creation or corrupted. Treat
    // as stale to avoid hanging forever on a half-dead lock.
    return true;
  }
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0); // signal 0 = liveness probe
    return false; // Process exists.
  } catch (err) {
    // ESRCH = no such process. Other errors (EPERM etc.) — assume alive
    // to be safe.
    return (err as { code?: string }).code === "ESRCH";
  }
}

function release(root: string, username: string): void {
  const lockDir = join(root, ".tmp", "locks", `${username}.lock`);
  if (!existsSync(lockDir)) return; // Already released.

  // Verify we still own it before deleting (paranoia against stale-claim races).
  const pidFile = join(lockDir, LOCK_PID_FILENAME);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (pid !== process.pid) {
      // Someone else's lock now (shouldn't happen, but tolerate).
      return;
    }
  }

  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best-effort — kernel will clean up on process exit anyway.
  }
}
