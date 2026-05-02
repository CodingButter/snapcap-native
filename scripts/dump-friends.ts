/**
 * Login each account in .snapcap-smoke.json, list its friends, resolve
 * usernames + displaynames + raw server fields via friends.getUsers, and
 * write the friends array back into the account's record on disk.
 *
 * After running, each account in .snapcap-smoke.json has a `friends`
 * field of shape `[{ userId, username, displayName?, raw? }, ...]` so the
 * roster — including any bitmoji ids / profile flags Snap returned — can
 * be inspected without re-authing. Useful for figuring out which accounts
 * are/aren't friends with each other before testing acceptRequest /
 * rejectRequest.
 *
 * Each account uses its own per-tenant `browser` config when present in
 * the JSON (UA / viewport / locale / timezone), falling back to
 * `smoke.fingerprint.userAgent` otherwise.
 *
 * Skips accounts marked status: "soft-blocked" or "hard-blocked".
 * Uses a SHARED throttle gate across all clients so the aggregate request
 * rate stays under Snap's anti-spam thresholds even when N > 2.
 *
 * Usage: bun run scripts/dump-friends.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  createSharedThrottle,
  RECOMMENDED_THROTTLE_RULES,
  type BrowserContext,
  type FriendsUser,
} from "../src/index.ts";

type Account = {
  username: string;
  password: string;
  authPath: string;
  status?: "accepted" | "soft-blocked" | "hard-blocked";
  lastVerifiedAt?: string;
  browser?: BrowserContext;
  friends?: FriendsUser[];
};

type Smoke = {
  accounts: Account[];
  fingerprint?: { userAgent: string };
  [k: string]: unknown;
};

const root = join(import.meta.dir, "..");
const smokePath = join(root, ".snapcap-smoke.json");
const smoke = JSON.parse(readFileSync(smokePath, "utf8")) as Smoke;
const fallbackUa = smoke.fingerprint?.userAgent ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const sharedGate = createSharedThrottle({ rules: RECOMMENDED_THROTTLE_RULES });

const usable = smoke.accounts.filter(a => a.status !== "soft-blocked" && a.status !== "hard-blocked");
console.log(`[dump-friends] ${usable.length}/${smoke.accounts.length} accounts to inspect`);

for (const acct of usable) {
  console.log(`\n[dump-friends] === ${acct.username} ===`);
  try {
    const browser: BrowserContext = acct.browser ?? { userAgent: fallbackUa };
    const client = new SnapcapClient({
      dataStore: new FileDataStore(join(root, acct.authPath)),
      credentials: { username: acct.username, password: acct.password },
      browser,
      throttle: sharedGate,
    });
    await client.authenticate();
    const list = await client.friends.list();
    const ids = list.map(f => f.userId);
    acct.friends = await client.friends.getUsers(ids);

    console.log(`[dump-friends]   ${acct.username}: ${acct.friends.length} friends`);
    for (const f of acct.friends) {
      const tag = f.notFound ? " [NOT FOUND]" : "";
      console.log(`  - ${f.username || "(no username)"} ${f.displayName ? `(${f.displayName})` : ""} [${f.userId.slice(0, 8)}…]${tag}`);
    }
  } catch (err) {
    console.error(`[dump-friends]   ${acct.username}: FAILED — ${(err as Error).message?.slice(0, 200)}`);
  }
}

writeFileSync(smokePath, JSON.stringify(smoke, null, 2) + "\n");
console.log(`\n[dump-friends] ✓ Wrote friends arrays back to ${smokePath}`);

// Cross-account symmetry check — usernames are now populated by getUsers
// above, so the simple username compare actually works this time.
console.log(`\n[dump-friends] === SYMMETRY CHECK ===`);
for (const a of usable) {
  for (const b of usable) {
    if (a.username === b.username) continue;
    const aSeesB = a.friends?.some(f => f.username === b.username) ?? false;
    const bSeesA = b.friends?.some(f => f.username === a.username) ?? false;
    const status = aSeesB && bSeesA ? "✓ mutual" :
                   aSeesB && !bSeesA ? "⚠ a→b only" :
                   !aSeesB && bSeesA ? "⚠ b→a only" :
                   "✗ neither";
    console.log(`  ${a.username} ↔ ${b.username}: ${status}`);
  }
}

process.exit(0);
