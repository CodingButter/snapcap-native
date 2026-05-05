/**
 * Standalone-realm WebSocket shim, backed by Node's `ws` library.
 *
 * The bundle's chunk constructs `new WebSocket(url, protocols)`
 * synchronously — it can't await a cookie lookup. The shim factory
 * pre-fetches the cookie header before returning the class, so each
 * synchronous ctor invocation can pass the pre-bound cookie inline.
 *
 * Cross-realm note: inbound `ArrayBuffer` data is reprojected through the
 * realm's own `Uint8Array` constructor (`VmU8`) so `instanceof
 * ArrayBuffer` checks inside the chunk pass against the realm's
 * `ArrayBuffer.prototype`, not the host's.
 *
 * NOTE: this shim deliberately stays separate from `src/shims/websocket.ts`
 * for now — that one is the main-Sandbox shim used by the bundle's
 * non-standalone WS calls. A future cleanup pass could fold both onto a
 * single factory; until then, keep the duplication explicit so changes
 * to one shim don't accidentally break the other.
 *
 * @internal
 */
import { WebSocket as NodeWS } from "ws";
import type { CookieJar } from "tough-cookie";

/** Options for {@link createWebSocketShim}. */
export type WebSocketShimOpts = {
  cookieJar: CookieJar;
  userAgent: string;
  /** Diagnostic logger; called on every WS lifecycle event. */
  log: (line: string) => void;
  /** Standalone-realm `Uint8Array` constructor for cross-realm data projection. */
  VmU8: Uint8ArrayConstructor;
};

/**
 * Pre-bind cookies for the duplex WS upgrade GET, then return a Node-`ws`
 * backed `WebSocket` class. Constructed once per `setupBundleSession`
 * call; the returned class becomes `realmGlobal.WebSocket`.
 *
 * The duplex client opens a SINGLE WS to `aws.duplex.snapchat.com`
 * during session bootstrap, so the pre-bound cookie header captured here
 * is what flows up on the upgrade.
 */
export async function createWebSocketShim(opts: WebSocketShimOpts) {
  const { cookieJar, userAgent, log, VmU8 } = opts;
  // The duplex client constructs `new WebSocket(url, [...])` synchronously;
  // it can't await a cookie lookup. Pre-fetch the cookie header here so
  // the WS shim's ctor can pull it inline.
  const preboundCookies = await cookieJar.getCookieString(
    "https://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
  );

  return class WebSocketShim {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    url: string;
    protocol = "";
    binaryType: "arraybuffer" | "nodebuffer" | "fragments" = "arraybuffer";
    readyState = 0;
    bufferedAmount = 0;
    extensions = "";

    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

    private inner: NodeWS;
    private listeners: Map<string, Set<(ev: unknown) => void>> = new Map();

    constructor(url: string, protocols?: string | string[]) {
      const stack = new Error().stack?.split("\n").slice(1, 8).join("\n  ") ?? "(no stack)";
      log(`[ws.shim] CTOR url=${url}\n  ${stack}`);
      this.url = url;
      this.inner = new NodeWS(url, protocols, {
        headers: {
          "User-Agent": userAgent,
          Origin: "https://www.snapchat.com",
          ...(preboundCookies ? { Cookie: preboundCookies } : {}),
        },
      });
      this.inner.binaryType = "arraybuffer";

      this.inner.on("open", () => {
        log(`[ws.shim] OPEN url=${url}`);
        this.readyState = 1;
        const ev = { type: "open", target: this };
        this.onopen?.(ev);
        this.fireListeners("open", ev);
      });
      this.inner.on("message", (data, isBinary) => {
        let normalized: ArrayBuffer | string;
        if (isBinary && Buffer.isBuffer(data)) {
          const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
          normalized = u8.buffer;
        } else if (data instanceof ArrayBuffer) {
          normalized = data;
        } else if (Buffer.isBuffer(data)) {
          normalized = data.toString("utf8");
        } else {
          normalized = data as unknown as ArrayBuffer;
        }
        if (process.env.SNAPCAP_DEBUG_WORKER) {
          const sz =
            typeof normalized === "string"
              ? normalized.length
              : (normalized as ArrayBuffer).byteLength;
          log(`[ws.shim] MSG ${typeof normalized === "string" ? "txt" : "bin"} ${sz}B`);
        }
        // Project ArrayBuffer into the sandbox realm so `instanceof
        // ArrayBuffer` checks inside the chunk pass.
        let projected: ArrayBuffer | string = normalized;
        if (normalized instanceof ArrayBuffer) {
          const VmU8inst = new VmU8(normalized.byteLength);
          VmU8inst.set(new Uint8Array(normalized));
          projected = VmU8inst.buffer;
        }
        const ev = { type: "message", data: projected, target: this };
        this.onmessage?.(ev);
        this.fireListeners("message", ev);
      });
      this.inner.on("error", (err) => {
        log(`[ws.shim] ERROR ${(err as Error).message ?? err}`);
        const ev = { type: "error", error: err, target: this };
        this.onerror?.(ev);
        this.fireListeners("error", ev);
      });
      this.inner.on("unexpected-response", (_req, res) => {
        log(`[ws.shim] UNEXPECTED-RESPONSE ${res.statusCode} ${res.statusMessage}`);
        const ev = {
          type: "error",
          error: new Error(`WS handshake HTTP ${res.statusCode}`),
          target: this,
        };
        this.onerror?.(ev);
        this.fireListeners("error", ev);
      });
      this.inner.on("close", (code, reasonBuf) => {
        this.readyState = 3;
        const reason = (reasonBuf as Buffer)?.toString?.("utf8") ?? "";
        const ev = {
          type: "close",
          code,
          reason,
          wasClean: code === 1000,
          target: this,
        };
        this.onclose?.(ev);
        this.fireListeners("close", ev);
      });
    }

    send(data: ArrayBuffer | Uint8Array | string): void {
      // Diagnostic: log every outbound WS frame at the wire boundary.
      // Lets us prove whether convMgr.sendTypingNotification (or any other
      // bundle-driven WS dispatch) actually produces a frame vs being
      // silently dropped inside the bundle.
      const sz =
        typeof data === "string"
          ? data.length
          : data instanceof ArrayBuffer
            ? data.byteLength
            : (data as Uint8Array).byteLength;
      let hexPrefix = "";
      if (typeof data !== "string") {
        const bytes =
          data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
        const head = bytes.subarray(0, Math.min(32, bytes.byteLength));
        hexPrefix = ` ${Array.from(head)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`;
      }
      log(`[ws.shim] SEND ${typeof data === "string" ? "txt" : "bin"} ${sz}B${hexPrefix}`);

      if (data instanceof ArrayBuffer) {
        this.inner.send(Buffer.from(new Uint8Array(data)));
      } else if (data instanceof Uint8Array) {
        this.inner.send(Buffer.from(data));
      } else if (typeof data === "string") {
        this.inner.send(data);
      } else {
        this.inner.send(data as never);
      }
    }
    close(code?: number, reason?: string): void {
      this.readyState = 2;
      this.inner.close(code, reason);
    }
    addEventListener(type: string, handler: (ev: unknown) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(handler);
    }
    removeEventListener(type: string, handler: (ev: unknown) => void): void {
      this.listeners.get(type)?.delete(handler);
    }
    private fireListeners(type: string, ev: unknown): void {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const h of set) {
        try {
          h(ev);
        } catch (e) {
          log(`[ws.shim.listener] throw ${(e as Error).message}`);
        }
      }
    }
  };
}
