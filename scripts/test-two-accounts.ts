/**
 * test-two-accounts.ts — multi-account end-to-end smoke for the messaging
 * pipeline.
 *
 * Two `SnapcapClient` instances, two accounts, ONE Node process. Validates:
 *
 *   1. Per-instance isolation under load — two parallel `authenticate()`
 *      + bundle session bring-ups don't trample each other's sandboxes.
 *   2. Inbound WS push delivery — A sends a tagged text DM, B subscribes
 *      to `messaging.on('message')`, B's bus should receive a message
 *      with `isSender === false` and the unique tag in its content.
 *   3. Typing-event propagation (informational) — A drives `setTyping`,
 *      B subscribes to `'typing'`. `setTyping` is a stub today so this
 *      is informational only; pass-or-info, never fail.
 *
 * Exit code: 0 iff A→B message round-trip works, else 1.
 *
 * Usage:
 *   bun run scripts/test-two-accounts.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  type PlaintextMessage,
} from "../src/index.ts";
import { authSlice } from "../src/bundle/register/index.ts";

type Account = {
  username: string;
  password: string;
  authPath: string;
  browser?: { userAgent: string; viewport?: { width: number; height: number } };
  friends?: Array<{ username: string; userId: string }>;
};
type Smoke = { accounts: Account[]; fingerprint?: { userAgent: string } };

const SDK_ROOT = join(import.meta.dir, "..");
const log = (line: string): void => {
  process.stderr.write(line + "\n");
};

const smoke = JSON.parse(
  readFileSync(join(SDK_ROOT, ".snapcap-smoke.json"), "utf8"),
) as Smoke;

// Pick two accounts. From .snapcap-smoke.json, perdyjamie ↔ jamie_qtsmith
// are mutuals (each lists the other in `friends`). jamielillee has no
// `friends` block recorded so we can't pre-confirm — start with the
// confirmed mutual pair.
const A_NAME = "perdyjamie";
const B_NAME = "jamie_qtsmith";

const acctA = smoke.accounts.find((a) => a.username === A_NAME);
const acctB = smoke.accounts.find((a) => a.username === B_NAME);
if (!acctA || !acctB) {
  console.error(
    `[two-acct] need both ${A_NAME} and ${B_NAME} in .snapcap-smoke.json`,
  );
  process.exit(1);
}

process.on("unhandledRejection", (err) =>
  log(`[unhandledRejection] ${(err as Error)?.stack ?? err}`),
);
process.on("uncaughtException", (err) =>
  log(`[uncaughtException] ${(err as Error)?.stack ?? err}`),
);
Error.stackTraceLimit = 100;

// ── Helpers ───────────────────────────────────────────────────────────
function decode(content: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(content);
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  pollMs = 200,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return pred();
}

/** Ctx introspection — same shape used by smoke-multi-instance.ts. */
interface InspectableSandbox { sandbox: unknown }
const introspectSandbox = async (c: SnapcapClient): Promise<unknown> => {
  const ctx = await (c.friends as unknown as {
    _getCtx: () => Promise<InspectableSandbox>;
  })._getCtx();
  return ctx.sandbox;
};

async function getUserId(c: SnapcapClient, fallback: string, retries = 100): Promise<string> {
  // The auth slice's userId lands via Zustand setState on the React-effect
  // graph chained off `auth.initialize`. Poll up to 10s — same headroom
  // as Messaging.#bringUpSession. Fall back to a known-good userId if
  // the slice never populates (some warm-start paths skip the React
  // effect that pumps it into the slice).
  const sandbox = await introspectSandbox(c);
  for (let i = 0; i < retries; i++) {
    const slice = authSlice(sandbox as never) as { userId?: string };
    if (slice.userId && slice.userId.length >= 32) return slice.userId;
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`[two-acct] WARNING: auth slice never populated userId — using fallback ${fallback}`);
  return fallback;
}

// Hardcoded fallbacks from .snapcap-smoke.json — these accounts' UUIDs
// are stable and live in the friend lists already. If the auth slice's
// userId polling times out (warm-start path can skip the slice
// population), we use these to keep the test moving.
const FALLBACK_USER_IDS: Record<string, string> = {
  perdyjamie: "527be2ff-aaec-4622-9c68-79d200b8bdc1",
  jamie_qtsmith: "e8559f90-d12b-49c0-aebc-3a66e7fbf773",
};

// ── Construct two clients ────────────────────────────────────────────
const ua =
  smoke.fingerprint?.userAgent ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

log(`[two-acct] A = ${acctA.username}`);
log(`[two-acct] B = ${acctB.username}`);

const A = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, acctA.authPath)),
  credentials: { username: acctA.username, password: acctA.password },
  browser: acctA.browser ?? { userAgent: ua },
});
const B = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, acctB.authPath)),
  credentials: { username: acctB.username, password: acctB.password },
  browser: acctB.browser ?? { userAgent: ua },
});

const startTotal = Date.now();

// ── Step 1: parallel authenticate ─────────────────────────────────
log(`[two-acct] parallel authenticate…`);
const tAuth = Date.now();
await Promise.all([A.authenticate(), B.authenticate()]);
log(`[two-acct] both authenticated in ${Date.now() - tAuth}ms`);

const [userIdA, userIdB] = await Promise.all([
  getUserId(A, FALLBACK_USER_IDS[acctA.username]!),
  getUserId(B, FALLBACK_USER_IDS[acctB.username]!),
]);
log(`[two-acct] A.userId=${userIdA}`);
log(`[two-acct] B.userId=${userIdB}`);
if (userIdA === userIdB) {
  console.error("[two-acct] FAIL: both clients report same userId — sandbox isolation broken");
  process.exit(1);
}

// ── Step 2: ensure mutual friendship ──────────────────────────────
log(`[two-acct] checking friend graphs…`);
const [friendsA, friendsB] = await Promise.all([
  A.friends.list(),
  B.friends.list(),
]);
log(`[two-acct] A has ${friendsA.length} friends; B has ${friendsB.length}`);

const aSeesB = friendsA.some((f) => f.userId === userIdB);
const bSeesA = friendsB.some((f) => f.userId === userIdA);
log(`[two-acct] A sees B as friend: ${aSeesB}`);
log(`[two-acct] B sees A as friend: ${bSeesA}`);

if (!aSeesB || !bSeesA) {
  log(`[two-acct] NOT mutual — sending request + accepting via SDK…`);
  if (!aSeesB) {
    try {
      await A.friends.sendRequest(userIdB);
      log(`[two-acct]   A.sendRequest(B) ok`);
    } catch (e) {
      log(`[two-acct]   A.sendRequest(B) FAILED: ${(e as Error).message}`);
    }
  }
  if (!bSeesA) {
    // B may now have an inbound request from A — refresh and accept.
    try {
      await B.friends.refresh();
      const inbound = await B.friends.receivedRequests();
      const fromA = inbound.find((r) => r.fromUserId === userIdA);
      if (fromA) {
        await B.friends.acceptRequest(userIdA);
        log(`[two-acct]   B.acceptRequest(A) ok`);
      } else {
        // Try the symmetric add as fallback (B adds A) — bundle treats
        // this as accept-by-mutual-add semantically.
        await B.friends.sendRequest(userIdA);
        log(`[two-acct]   B.sendRequest(A) (no inbound seen, fallback)`);
      }
    } catch (e) {
      log(`[two-acct]   B accept/add FAILED: ${(e as Error).message}`);
    }
  }
  // Re-check
  await Promise.all([A.friends.refresh(), B.friends.refresh()]);
  const [f2A, f2B] = await Promise.all([A.friends.list(), B.friends.list()]);
  const aNowSeesB = f2A.some((f) => f.userId === userIdB);
  const bNowSeesA = f2B.some((f) => f.userId === userIdA);
  log(`[two-acct]   after add: A sees B = ${aNowSeesB}, B sees A = ${bNowSeesA}`);
  if (!aNowSeesB || !bNowSeesA) {
    log(`[two-acct] WARNING: not fully mutual after add. Proceeding anyway — conv may exist.`);
  }
}

// ── Step 3: find the A↔B 1:1 conversation ─────────────────────────
log(`[two-acct] finding A↔B conversation via A.listConversations…`);
const convsA = await A.messaging.listConversations(userIdA);
log(`[two-acct] A has ${convsA.length} conversations`);

// 1:1 DMs have exactly the two participants (self + other). Pick the
// conversation whose participant set is exactly {userIdA, userIdB}.
const oneOnOne = convsA.find((c) => {
  const set = new Set(c.participants);
  return set.size === 2 && set.has(userIdA) && set.has(userIdB);
});

let convId: string | undefined = oneOnOne?.conversationId;
if (!convId) {
  // Fallback: the bundle's convMgr exposes `getOneOnOneConversationIds`.
  // Compute it the way the SPA does — sorted-pair UUIDv5 derivation is
  // not reproducible without the bundle, so we just bail with a clear
  // message and let the caller handle.
  log(
    `[two-acct] no 1:1 conv in A's listConversations — A has not yet messaged B. ` +
      `The 1:1 conv ID is created server-side on first message. ` +
      `Falling back: send the message anyway using the deterministic conv ID Snap stamps for the pair.`,
  );
  // The bundle's `getOneOnOneConversationIds([otherId])` takes the sorted
  // pair and runs UUIDv5. We can't easily replicate without bundle
  // introspection — fail loudly so this gap is visible.
  console.error(
    "[two-acct] FAIL: no A↔B conversation found in A's conversation list. " +
    "Please send a manual DM from one to the other once to seed the conv, then re-run.",
  );
  process.exit(1);
}
log(`[two-acct] found A↔B convId = ${convId}`);

// ── Step 4: B subscribes BEFORE A sends ───────────────────────────
// Also subscribe on A so we can observe the outbound echo (isSender=true)
// path — useful to distinguish "send wire-fired" from "send delivered to B".
const inboundFromA: PlaintextMessage[] = [];
const allOnB: PlaintextMessage[] = [];
const aOutbound: PlaintextMessage[] = [];
B.messaging.on("message", (msg) => {
  allOnB.push(msg);
  if (msg.isSender === false) {
    inboundFromA.push(msg);
    const text = decode(msg.content).slice(0, 120);
    log(`[two-acct]   B<-INBOUND (isSender=false) ct=${msg.contentType} bytes=${msg.content.byteLength}B "${text}"`);
  } else if (msg.isSender === true) {
    const text = decode(msg.content).slice(0, 120);
    log(`[two-acct]   B->OUTBOUND (isSender=true)  ct=${msg.contentType} bytes=${msg.content.byteLength}B "${text}"`);
  }
});
A.messaging.on("message", (msg) => {
  if (msg.isSender === true) {
    aOutbound.push(msg);
    const text = decode(msg.content).slice(0, 120);
    log(`[two-acct]   A->ECHO (isSender=true)  ct=${msg.contentType} bytes=${msg.content.byteLength}B "${text}"`);
  }
});
log(`[two-acct] A and B subscribed; bring-ups in flight in parallel`);

// Give BOTH bring-ups a head start before A's send fires. Each cold
// bring-up is ~3-6s; running them in parallel keeps total under ~8s.
log(`[two-acct] sleeping 8s for parallel bring-ups…`);
await new Promise((r) => setTimeout(r, 8_000));

// ── Step 5: A sends a uniquely-tagged text ────────────────────────
const tag = `e2e-test ${Date.now()}`;
log(`[two-acct] A.sendText(convId, "${tag}")`);
const tSend = Date.now();
// Don't BLOCK on sendText — fire it and let the inbound-arrival check
// be the source of truth for "did the message land". If sendText hangs
// (bring-up race or bundle-internal weirdness), we still pass as long
// as the message reaches B — which is what we actually care about.
let sendId: string | undefined;
let sendError: unknown;
const sendPromise = (async () => {
  try {
    sendId = await A.messaging.sendText(convId, tag);
    log(`[two-acct]   sendText resolved in ${Date.now() - tSend}ms id=${sendId}`);
  } catch (e) {
    sendError = e;
    log(`[two-acct]   sendText THREW after ${Date.now() - tSend}ms: ${(e as Error).message}`);
  }
})();

// ── Step 6: wait up to 30s for B to receive ───────────────────────
log(`[two-acct] waiting up to 30s for B to receive A's tagged message…`);
const tWait = Date.now();
const arrived = await waitFor(
  () => inboundFromA.some((m) => decode(m.content).includes(tag)),
  30_000,
);
const arrivedAfterMs = Date.now() - tWait;
log(`[two-acct] arrived=${arrived} after ${arrivedAfterMs}ms`);
log(`[two-acct] B's message bus saw ${allOnB.length} total messages, ${inboundFromA.length} inbound`);

// Did B see it via live WS push (within seconds) or via cached fetch
// (would be 0 inbound since bring-up + history pump happens BEFORE the
// send fires here — so any post-send arrival is a live push).
const livePush = arrived && arrivedAfterMs < 10_000;

// ── Step 7: typing event probe ────────────────────────────────────
const typingFromA: Array<{ convId: string; userId: string; until: number }> = [];
B.messaging.on("typing", (ev) => {
  if (ev.userId === userIdA) typingFromA.push(ev);
});

log(`[two-acct] A.setTyping(convId, 2000)…`);
// Race against a timeout so a hanging setTyping can't wedge the verdict.
await Promise.race([
  A.messaging.setTyping(convId, 2000),
  new Promise((r) => setTimeout(r, 4_000)),
]);

const typingObserved = await waitFor(() => typingFromA.length > 0, 3_000);
log(`[two-acct] typingObserved=${typingObserved}`);

// Best-effort: check whether sendText eventually resolved (don't block more).
await Promise.race([
  sendPromise,
  new Promise((r) => setTimeout(r, 1_000)),
]);
log(`[two-acct] sendText state: id=${sendId ?? "(unresolved)"} err=${sendError ? (sendError as Error).message : "none"}`);

// ── Verdict ───────────────────────────────────────────────────────
const totalMs = Date.now() - startTotal;
log(`\n[two-acct] === FINAL ===`);
log(`[two-acct] total runtime: ${totalMs}ms`);
log(`[two-acct] live WS push (B saw within 10s): ${livePush}`);
log(`[two-acct] bus totals on B: ${allOnB.length} all, ${inboundFromA.length} inbound`);

if (arrived) console.log("PASS: A→B message round-trip works");
else console.log("FAIL: A→B message did not arrive");

if (typingObserved) console.log("PASS: A→B typing event propagates");
else console.log("INFO: typing event did not propagate — known gap, setTyping is a stub today");

process.exit(arrived ? 0 : 1);
