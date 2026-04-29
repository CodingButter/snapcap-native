/**
 * Duplex WebSocket transport — required for real-time presence dispatch.
 *
 * Snap's gRPC-Web HTTP endpoints accept presence/typing notifications and
 * record them server-side, but they only fan out to recipients when the
 * sender's session has an active connection on the duplex WebSocket. The
 * WS speaks gRPC-Web framing (5-byte length-prefix header) carrying
 * proto messages with a "kind" string field plus a body.
 *
 * Connection:
 *   wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect
 *   Sec-WebSocket-Protocol: snap-ws-auth, <bearer>
 *
 * Frame format (outbound):
 *   [5-byte gRPC-Web header: flag(1) + len(4 BE)] [proto body]
 *
 * Body shapes vary by message kind. For presence + typing the kind is
 * "http://pcs.snap/send-transient-message" with a nested envelope
 * identifying the channel ("presence" or "chat") and the conversation +
 * peer user.
 */
import WebSocket from "ws";
import type { CookieJar } from "tough-cookie";
import { ProtoWriter, uuidToBytes } from "./proto-encode.ts";

export type DuplexOpts = {
  bearer: string;
  /**
   * Cookie jar with parent-domain cookies (sc-a-nonce, _scid, sc_at, …).
   * The WS handshake is a GET request and Snap's gateway expects the same
   * cookie set as gRPC calls; without it the server returns 401 on the
   * upgrade.
   */
  jar: CookieJar;
  /** Override the default URL. Mostly for staging or recon. */
  url?: string;
  /** Extra origin/UA hints — most callers can leave these defaulted. */
  origin?: string;
  userAgent?: string;
};

export type Duplex = {
  /**
   * Send a "send-transient-message" PCS frame on a named channel
   * (e.g. "presence", "chat"). Body is the per-channel payload.
   *
   * `peerUserId` goes into the outer envelope — it's the OTHER user in
   * the conversation (recipient/peer). The body itself identifies the
   * sender via its own embedded fields.
   */
  sendTransient(channel: string, body: Uint8Array, peerUserId: string): void;
  /** Close the connection. */
  close(): void;
  /** Resolves once the WS is OPEN; rejects on connect failure. */
  ready: Promise<void>;
  /**
   * Stable random session ID generated once per WS connection. The server
   * uses this to demultiplex our publishes. Browsers send a 16-digit
   * number — we mimic that shape here. Pass to buildPresenceBody().
   */
  sessionId: bigint;
};

const DEFAULT_URL = "wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect";

export async function connectDuplex(opts: DuplexOpts): Promise<Duplex> {
  const url = opts.url ?? DEFAULT_URL;
  const cookie = await opts.jar.getCookieString(url.replace(/^wss:/, "https:"));
  const ws = new WebSocket(url, ["snap-ws-auth", opts.bearer], {
    headers: {
      "User-Agent": opts.userAgent ??
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      Origin: opts.origin ?? "https://www.snapchat.com",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });

  let resolveReady: () => void;
  let rejectReady: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ws.on("open", () => resolveReady());
  ws.on("unexpected-response", (_req, res) => {
    rejectReady(new Error(`duplex WS handshake failed: HTTP ${res.statusCode}`));
  });
  ws.on("error", (e) => {
    const msg = e instanceof Error ? e.message : (e as { message?: string }).message ?? String(e);
    rejectReady(new Error(`duplex WS error: ${msg}`));
  });

  const send = (channel: string, body: Uint8Array, recipientUserId: string): void => {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error(`duplex WS not open (state=${ws.readyState})`);
    }
    // Outer envelope: { 1: kind-string, 2: { 1: { 1: { 1: bytes16 recipient }}, 10: { 1: channel, 2: <body> } } }
    const w = new ProtoWriter();
    w.fieldString(1, "http://pcs.snap/send-transient-message");
    w.fieldMessage(2, (env) => {
      env.fieldMessage(1, (target) => {
        target.fieldMessage(1, (inner) => {
          inner.fieldBytes(1, uuidToBytes(recipientUserId));
        });
      });
      env.fieldMessage(10, (chan) => {
        chan.fieldString(1, channel);
        chan.fieldBytes(2, body);
      });
    });
    const proto = w.finish();
    // gRPC-Web frame: 1-byte flag + 4-byte BE length + payload.
    const framed = new Uint8Array(5 + proto.byteLength);
    framed[0] = 0;
    new DataView(framed.buffer).setUint32(1, proto.byteLength, false);
    framed.set(proto, 5);
    ws.send(framed);
  };

  // 16-digit random — matches the shape we observed from real browsers.
  // Top 50 bits from Date.now()<<14, low 48 bits from crypto random.
  const sessionId =
    (BigInt(Date.now()) << 14n) |
    (BigInt(Math.floor(Math.random() * 0xffff_ffff_ffff)));

  return {
    sendTransient: send,
    close: () => ws.close(),
    ready,
    sessionId,
  };
}
