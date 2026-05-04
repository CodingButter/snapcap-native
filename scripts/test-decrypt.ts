/**
 * test-decrypt.ts — end-to-end inbound message decrypt verifier.
 *
 * Authenticates `perdyjamie`, then subscribes to `client.messaging.on('message')`.
 * The first subscription triggers lazy bring-up of the bundle session
 * (mints/registers Fidelius identity if needed, evals the f16f14e3 chunk,
 * opens the duplex WS, wires the messaging delegate). Plaintext messages
 * flow through the wrapped delegate and fire the `message` event.
 *
 * Pass criterion: at least one PLAIN ← INBOUND line is captured within
 * the 30-second wait window. Exits 0 on success, 1 on failure.
 *
 * Usage:
 *   bun run scripts/test-decrypt.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SnapcapClient,
  FileDataStore,
  type PlaintextMessage,
} from "../src/index.ts";

/** Coerce an Embind UUID-shaped value to a UUID string. */
function uuidLikeFrom(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
  const obj = v as Record<string, unknown>;
  let bytes: number[] | undefined;
  if (obj.id) {
    const id = obj.id as Record<string, unknown> | Uint8Array;
    if (id instanceof Uint8Array && id.byteLength === 16) bytes = Array.from(id);
    else if (typeof id === "object") {
      const u = id as { byteLength?: number; [k: number]: number };
      if (u.byteLength === 16) bytes = Array.from({ length: 16 }, (_, i) => u[i] ?? 0);
      else {
        const keys = Object.keys(id);
        if (keys.length >= 16 && keys.every((k) => /^\d+$/.test(k))) {
          bytes = Array.from({ length: 16 }, (_, i) => (id as Record<string, number>)[String(i)] ?? 0);
        }
      }
    }
  } else if (v instanceof Uint8Array && v.byteLength === 16) bytes = Array.from(v);
  if (!bytes) return undefined;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  console.error("[test-decrypt] perdyjamie not in .snapcap-smoke.json");
  process.exit(1);
}

process.on("unhandledRejection", (err) =>
  log(`[unhandledRejection] ${(err as Error)?.stack ?? err}`),
);
process.on("uncaughtException", (err) =>
  log(`[uncaughtException] ${(err as Error)?.stack ?? err}`),
);
Error.stackTraceLimit = 100;

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

log(`[test-decrypt] authenticating ${acct.username}…`);
await client.authenticate();
const bearer = client.getAuthToken();
if (!bearer) {
  console.error("[test-decrypt] no bearer after authenticate");
  process.exit(1);
}
log(`[test-decrypt] authenticated. bearer=${bearer.slice(0, 20)}…`);

// ── Subscribe — bring-up triggers lazily on first .on() ─────────────
const captured: PlaintextMessage[] = [];
const inboundCount = { n: 0 };

client.messaging.on("message", (msg) => {
  captured.push(msg);
  if (msg.isSender === false) inboundCount.n++;
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(msg.content);
  // Replace non-printable bytes so the verifier's grep doesn't fall into
  // binary-detection mode.
  const printable = utf8.replace(/[^\x20-\x7e\n]/g, "·").replace(/\n/g, "\\n");
  const dir =
    msg.isSender === false ? "<- INBOUND" : msg.isSender === true ? "-> outbound" : "  ?      ";
  const raw = msg.raw as Record<string, unknown> | undefined;
  const senderRaw = raw?.senderUserId ?? (raw?.senderUser as Record<string, unknown> | undefined)?.id ?? raw?.fromUserId;
  const convRaw = raw?.conversationId ?? (raw?.conversation as Record<string, unknown> | undefined)?.id ?? (raw?.conversationMetricsData as Record<string, unknown> | undefined)?.conversationId;
  const senderHex = uuidLikeFrom(senderRaw);
  const convHex = uuidLikeFrom(convRaw);
  process.stdout.write(
    `PLAIN: ${dir} ct=${msg.contentType} from=${senderHex ?? "?"} conv=${convHex ?? "?"} bytes=${msg.content.byteLength}B  text: ${printable.slice(0, 240)}\n`,
  );
});

log(`[test-decrypt] subscribed; lazy bring-up in flight…`);

// ── Wait for backlog + live messages ─────────────────────────────
log(`\n[test-decrypt] waiting 30s for messages (send a fresh message to ${acct.username} now)…`);
const liveStart = Date.now();
const WAIT_MS = 30_000;
let lastReported = 0;
while (Date.now() - liveStart < WAIT_MS) {
  if (captured.length > lastReported) {
    log(
      `[test-decrypt] +${captured.length - lastReported} captures (total=${captured.length}, inbound=${inboundCount.n})`,
    );
    lastReported = captured.length;
  }
  await new Promise((r) => setTimeout(r, 250));
}

// ── Final verdict ─────────────────────────────────────────────────
log(`\n[test-decrypt] === FINAL ===`);
log(`[test-decrypt] total captures: ${captured.length}`);
log(`[test-decrypt] inbound captures: ${inboundCount.n}`);

if (inboundCount.n > 0) {
  log(`[test-decrypt] PASS: ${inboundCount.n} inbound messages decrypted`);
  process.exit(0);
} else {
  log(
    `[test-decrypt] FAIL: no inbound plaintext captured in ${WAIT_MS / 1000}s. ` +
      `If perdyjamie has no recent inbound messages, the bundle's WASM has nothing to decrypt — ` +
      `send a DM to perdyjamie from another account and re-run.`,
  );
  process.exit(1);
}
