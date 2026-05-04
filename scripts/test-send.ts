/**
 * test-send.ts — outbound DM verification.
 *
 * Authenticates `perdyjamie`, sends a fresh text DM into the
 * `jamie_nichols` conversation, subscribes to the messaging stream, and
 * waits up to 30s for the matching outbound message to fire through the
 * bundle's `onMessageReceived` delegate (with `isSender === true`).
 *
 * Pass criterion: at least one outbound message captured matching the
 * sent text. Exits 0 on success, 1 on failure.
 *
 * Usage:
 *   bun run scripts/test-send.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  type PlaintextMessage,
} from "../src/index.ts";

type Account = {
  username: string;
  password: string;
  authPath: string;
  browser?: { userAgent: string; viewport?: { width: number; height: number } };
};
type Smoke = { accounts: Account[]; fingerprint?: { userAgent: string } };

const SDK_ROOT = join(import.meta.dir, "..");
const log = (line: string): void => {
  process.stderr.write(line + "\n");
};

const smoke = JSON.parse(
  readFileSync(join(SDK_ROOT, ".snapcap-smoke.json"), "utf8"),
) as Smoke;
const acct = smoke.accounts.find((a) => a.username === "perdyjamie");
if (!acct) {
  console.error("[test-send] perdyjamie not in .snapcap-smoke.json");
  process.exit(1);
}

process.on("unhandledRejection", (err) =>
  log(`[unhandledRejection] ${(err as Error)?.stack ?? err}`),
);
process.on("uncaughtException", (err) =>
  log(`[uncaughtException] ${(err as Error)?.stack ?? err}`),
);
Error.stackTraceLimit = 100;

const TARGET_CONV = "8fee42df-e549-5727-a893-034382ccab89";
const SENT_TEXT = `snapcap-send-test ${Date.now()}`;

// ── Boot the SDK + authenticate ────────────────────────────────────
const dataStore = new FileDataStore(join(SDK_ROOT, acct.authPath));
const client = new SnapcapClient({
  dataStore,
  credentials: { username: acct.username, password: acct.password },
  browser: acct.browser ?? {
    userAgent:
      smoke.fingerprint?.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  },
});

log(`[test-send] authenticating ${acct.username}…`);
await client.authenticate();
const bearer = client.getAuthToken();
if (!bearer) {
  console.error("[test-send] no bearer after authenticate");
  process.exit(1);
}
log(`[test-send] authenticated. bearer=${bearer.slice(0, 20)}…`);

// ── Subscribe to outbound capture before firing the send ─────────────
const captured: PlaintextMessage[] = [];
let outboundMatch = false;

client.messaging.on("message", (msg) => {
  captured.push(msg);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(msg.content);
  const printable = utf8.replace(/[^\x20-\x7e\n]/g, "·").replace(/\n/g, "\\n");
  const dir = msg.isSender === true ? "-> outbound" : msg.isSender === false ? "<- inbound " : "?         ";
  process.stdout.write(`PLAIN: ${dir} ct=${msg.contentType} bytes=${msg.content.byteLength}B  text: ${printable.slice(0, 240)}\n`);
  if (msg.isSender === true && utf8.includes(SENT_TEXT)) {
    outboundMatch = true;
  }
});

// ── Fire the send ───────────────────────────────────────────────────
log(`[test-send] sendText("${TARGET_CONV}", "${SENT_TEXT}")`);
let sendId: string | undefined;
try {
  sendId = await client.messaging.sendText(TARGET_CONV, SENT_TEXT);
  log(`[test-send] sendText resolved id=${sendId}`);
} catch (e) {
  log(`[test-send] FAIL sendText threw: ${(e as Error).stack ?? e}`);
  process.exit(1);
}

// ── Compile-check: sendImage / sendSnap / stories.post should not throw at type-level
// We don't actually call them with bytes (no test image handy), but
// dereference the methods to confirm they exist.
const _sendImage = client.messaging.sendImage.bind(client.messaging);
const _sendSnap = client.messaging.sendSnap.bind(client.messaging);
const _storiesPost = client.stories.post.bind(client.stories);
void _sendImage; void _sendSnap; void _storiesPost;
log(`[test-send] sendImage / sendSnap / stories.post bound OK`);

// ── Wait up to 30s for the outbound to surface via WS push ─────────
log(`[test-send] waiting up to 30s for outbound message echo…`);
const WAIT_MS = 30_000;
const start = Date.now();
while (Date.now() - start < WAIT_MS && !outboundMatch) {
  await new Promise((r) => setTimeout(r, 250));
}

// ── Verdict ──────────────────────────────────────────────────────
log(`\n[test-send] === FINAL ===`);
log(`[test-send] sent text: "${SENT_TEXT}"`);
log(`[test-send] sendText returned id: ${sendId}`);
log(`[test-send] total captures: ${captured.length}`);
log(`[test-send] outbound match: ${outboundMatch}`);

if (outboundMatch) {
  log(`[test-send] PASS: outbound message captured with isSender=true and matching text`);
  process.exit(0);
} else {
  log(`[test-send] FAIL: no outbound message echo within ${WAIT_MS / 1000}s`);
  process.exit(1);
}
