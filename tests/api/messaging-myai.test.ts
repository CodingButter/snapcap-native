/**
 * My AI single-instance live-push test.
 *
 * # Why My AI
 *
 * Validates the live WS push path (`messaging.on('message', ...)` fires from
 * the duplex WS) without needing two `SnapcapClient` instances or any
 * friend-asymmetry workaround. My AI:
 *
 *   - is auto-friended on every Snap account → no friend-graph asymmetry
 *   - replies within seconds → reliable verification signal
 *   - lives in a single instance → no two-client throttling tax
 *   - sends CLEARTEXT replies (`cleartextBody?: string` on
 *     `RawEncryptedMessage`) so the live-push path is exercised even when
 *     Fidelius decrypt is gated.
 *
 * Validates the EXACT live-push gap that
 * `tests/api/messaging-multi-account.test.ts :: A.sendText surfaces on
 * B.on('message')` pins — but without the cross-instance noise.
 *
 * # Hard limits
 *
 *   - ONE send per run. Don't loop while iterating.
 *   - Mandatory 5s sleep before send (TEST_THROTTLE_FLOOR_MS).
 *   - Cap test runs to <5 per session — My AI is rate-limited too.
 *   - 60s minimum between manual re-runs.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { SnapcapClient } from "../../src/client.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import { RECOMMENDED_THROTTLE_RULES, type PlaintextMessage } from "../../src/index.ts";
import {
  checkoutUser,
  releaseUser,
  type LockedUser,
} from "../lib/user-locker.ts";

// ── Noise suppression ────────────────────────────────────────────────────
// Same shape as messaging-multi-account.test.ts. The standalone-WASM mint
// throws a benign `setAttribute` from a browser-only iframe init path; the
// mint catches it but the throw still surfaces as an unhandled error on
// Bun's loop. Swallow ONLY this specific bundle-internal noise.
process.on("uncaughtException", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) {
    process.stderr.write(`[suppress-bundle-noise] ${msg.slice(0, 120)}\n`);
    return;
  }
  process.stderr.write(`[uncaughtException] ${(err as Error)?.stack ?? err}\n`);
});
process.on("unhandledRejection", (err) => {
  const msg = (err as Error)?.message ?? "";
  if (msg.includes("setAttribute") || msg.includes("not an object")) {
    process.stderr.write(`[suppress-bundle-noise] ${msg.slice(0, 120)}\n`);
    return;
  }
  process.stderr.write(`[unhandledRejection] ${(err as Error)?.stack ?? err}\n`);
});

// ── Constants ────────────────────────────────────────────────────────────

/** This test prefers `perdyjamie` because the cached myai userId in its
 * config has been verified. The locker will fall through to another account
 * if perdyjamie is busy — but that account's friends list also needs a
 * "myai" entry, which is an invariant per Snap (auto-friended on every
 * account). */
const PREFER_USER = "perdyjamie";

/** Hard sleep before the single send. Matches multi-account test. */
const TEST_THROTTLE_FLOOR_MS = 5_000;

/** Cap on time we wait for My AI's reply to land via on("message"). My
 * AI normally replies in <5s; if 25s passes with no reply, the live-push
 * pipeline is broken (or My AI is flaky). Fail fast instead of holding
 * the suite for a slow timeout. */
const REPLY_WAIT_MS = 25_000;

function decode(content: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Fixture state ────────────────────────────────────────────────────────

let client: SnapcapClient;
let lockedUser: LockedUser;
let myAiConvId: string;
let myAiUserId: string;
let selfUserId: string;

interface InspectableSandbox { sandbox: unknown }
async function introspectSandbox(c: SnapcapClient): Promise<unknown> {
  const ctx = await (c.friends as unknown as {
    _getCtx: () => Promise<InspectableSandbox>;
  })._getCtx();
  return ctx.sandbox;
}

beforeAll(async () => {
  // Lock an account from the pool. PREFER perdyjamie (its myai userId is
  // verified-cached) but fall through to others if it's busy. Per Snap,
  // every account is auto-friended with My AI so any account works once
  // its config has the myai friend cached.
  lockedUser = await checkoutUser({ preferUser: PREFER_USER });

  // Resolve My AI's userId from the locked user's cached friends list.
  // Friends list is captured per-account during smoke runs and stored in
  // the config. Avoiding a hardcoded UUID keeps the test resilient to
  // account re-provisioning.
  const aiFriend = (lockedUser.config.friends as Array<{ username: string; userId: string }> | undefined)
    ?.find((f) => f.username === "myai");
  if (!aiFriend) {
    throw new Error(
      `beforeAll: no "myai" friend cached on ${lockedUser.username}'s config. ` +
      `My AI should be auto-friended on every Snap account; re-run the ` +
      `friend-list capture for this account.`,
    );
  }
  myAiUserId = aiFriend.userId;

  client = new SnapcapClient({
    dataStore: new FileDataStore(lockedUser.storagePath),
    credentials: { username: lockedUser.username, password: lockedUser.config.password },
    browser: { userAgent: lockedUser.config.fingerprint.userAgent },
    throttle: { rules: RECOMMENDED_THROTTLE_RULES },
  });
  await client.authenticate();
  if (!client.isAuthenticated()) {
    throw new Error("beforeAll: authenticate() resolved but isAuthenticated()=false");
  }

  // Resolve self userId from the chat-bundle auth slice. Same pattern as
  // messaging-multi-account.test.ts — Zustand setState lands the userId
  // some hundreds of ms after authenticate() resolves; poll up to 30s.
  const { authSlice } = await import("../../src/bundle/register/index.ts");
  const sandbox = await introspectSandbox(client);
  for (let i = 0; i < 300; i++) {
    const slice = authSlice(sandbox as never) as { userId?: string };
    if (slice.userId && slice.userId.length >= 32) {
      selfUserId = slice.userId;
      break;
    }
    await sleep(100);
  }
  if (!selfUserId) {
    throw new Error(
      `beforeAll: auth slice never populated userId after 30s for ${lockedUser.username}. ` +
      `Cold-fresh auth path may be broken — investigate auth.ts kickoffMessagingSession.`,
    );
  }

  // Find the 1:1 conversation between us and My AI. My AI is just another
  // userId on the conv graph — the conv where the only other participant
  // matches `myAiUserId`.
  const convs = await client.messaging.listConversations(selfUserId);
  const myAiConv = convs.find((c) => {
    const set = new Set(c.participants);
    return set.has(myAiUserId);
  });
  if (!myAiConv) {
    throw new Error(
      `beforeAll: no conversation containing My AI (${myAiUserId}) in ` +
      `${lockedUser.username}'s conv list. Open Snap web once and tap the ` +
      `My AI chat to seed the conv server-side, then re-run.`,
    );
  }
  myAiConvId = myAiConv.conversationId;

  // Pre-warm the bundle messaging session in beforeAll. Without this, the
  // standalone-WASM mint's benign `setAttribute` throw can fire DURING the
  // test and Bun aborts (per the lesson from messaging-multi-account.test).
  const noopUnsub = client.messaging.on("message", () => {});
  await client.messaging.setTyping(myAiConvId, 0).catch(() => {});
  noopUnsub();

  process.stderr.write(
    `[beforeAll] account=${lockedUser.username} myAiUserId=${myAiUserId} myAiConvId=${myAiConvId} type=${myAiConv.type}\n`,
  );
}, 120_000);

afterAll(() => {
  if (lockedUser) releaseUser(lockedUser);
});

// ─── Live-push round-trip via My AI ─────────────────────────────────────

describe("My AI live push", () => {
  test("sendText to My AI surfaces auto-reply on on('message') within 30s", async () => {
    const tag = `myai-test ${Date.now()}`;
    const sendStartedAt = Date.now();

    // Track every inbound message that's NOT us, and accept the reply via
    // either decrypted `content` OR the parsed `cleartextBody` (Snap stores
    // AI bot replies as plaintext in the envelope so the live-push path
    // works even before Fidelius decrypt lands).
    const inbound: Array<PlaintextMessage & { _arrivedAt: number }> = [];
    const sub = client.messaging.on("message", (msg) => {
      if (msg.isSender === false) {
        (msg as PlaintextMessage & { _arrivedAt: number })._arrivedAt = Date.now();
        inbound.push(msg as PlaintextMessage & { _arrivedAt: number });
      }
    });

    try {
      // Throttle floor — belt-and-braces with the per-method gate. WS-push
      // doesn't pass through the HTTP throttle so the explicit sleep is
      // load-bearing here.
      process.stderr.write(`[throttle] sleeping ${TEST_THROTTLE_FLOOR_MS}ms before sendText\n`);
      await sleep(TEST_THROTTLE_FLOOR_MS);

      await client.messaging.sendText(myAiConvId, tag);
      const sendDispatchedAt = Date.now();
      process.stderr.write(
        `[sendText] dispatched in ${sendDispatchedAt - sendStartedAt - TEST_THROTTLE_FLOOR_MS}ms (post-throttle)\n`,
      );

      // Poll the inbound buffer every 500ms up to REPLY_WAIT_MS for a
      // message that:
      //  (a) belongs to the My AI conv, AND
      //  (b) has SOME plaintext body — either decrypted `content` (text)
      //      or the parsed `cleartextBody` on the raw envelope. We exclude
      //      our own outbound `tag` echo (isSender filter handles that;
      //      additional defensive check on body content keeps an empty
      //      delegate-fired echo from passing).
      const arrivedAt = await new Promise<number | null>((resolve) => {
        const start = Date.now();
        const poll = setInterval(() => {
          for (const m of inbound) {
            const raw = m.raw as { conversationId?: string; cleartextBody?: string };
            const inAiConv = raw?.conversationId === myAiConvId;
            const decoded = decode(m.content);
            const cleartext = raw?.cleartextBody ?? "";
            // Reject our own tag echo if it surfaces on the inbound side.
            const isOurEcho = decoded.includes(tag) || cleartext.includes(tag);
            const hasBody = decoded.trim().length > 0 || cleartext.trim().length > 0;
            if (inAiConv && hasBody && !isOurEcho) {
              clearInterval(poll);
              resolve(m._arrivedAt);
              return;
            }
          }
          if (Date.now() - start > REPLY_WAIT_MS) {
            clearInterval(poll);
            resolve(null);
          }
        }, 500);
      });

      if (arrivedAt === null) {
        process.stderr.write(
          `[FAIL] no My AI reply within ${REPLY_WAIT_MS}ms — captured ${inbound.length} ` +
          `inbound messages total: ${JSON.stringify(
            inbound.map((m) => ({
              convId: (m.raw as { conversationId?: string })?.conversationId,
              ct: m.contentType,
              len: m.content.byteLength,
              cleartext: ((m.raw as { cleartextBody?: string })?.cleartextBody ?? "").slice(0, 80),
              text: decode(m.content).slice(0, 80),
            })),
            null, 2,
          )}\n`,
        );
      } else {
        const ttfr = arrivedAt - sendStartedAt - TEST_THROTTLE_FLOOR_MS;
        const winner = inbound.find((m) => m._arrivedAt === arrivedAt)!;
        const raw = winner.raw as { cleartextBody?: string };
        const decoded = decode(winner.content);
        const cleartext = raw?.cleartextBody ?? "";
        const surface =
          decoded.trim().length > 0 ? `decrypted content (${decoded.length}b)` :
          `cleartextBody (${cleartext.length}b)`;
        process.stderr.write(
          `[PASS] My AI reply landed via ${surface} in ${ttfr}ms post-send. ` +
          `body: ${(decoded || cleartext).slice(0, 200)}\n`,
        );
      }

      expect(arrivedAt).not.toBeNull();
    } finally {
      sub();
    }
  }, 60_000); // outer cap: 5s throttle + 25s reply wait + slack
});
