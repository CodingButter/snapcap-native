/**
 * Sandbox `WebSocket` shim — projects a browser-shaped WebSocket class
 * onto `sandbox.window.WebSocket` that wraps Node's `ws` package.
 *
 * Why this exists:
 *   - The bundle's chat WS code (chunk f16f14e3, duplex client) does
 *     `new WebSocket(url, protocols)`, attaches `onopen` / `onmessage`,
 *     and checks `e.data instanceof ArrayBuffer` against the SANDBOX's
 *     own ArrayBuffer constructor (cross-realm). happy-dom's bundled
 *     `WebSocket` doesn't ride our cookie/UA fingerprint, and Node's
 *     `ws` is a very different shape — neither works as-is.
 *   - The handshake to `aws.duplex.snapchat.com` requires parent-domain
 *     cookies (`sc-a-nonce`, `_scid`, `sc_at`) on the upgrade GET. Those
 *     live in the same shared tough-cookie jar that backs document.cookie
 *     and the host-realm grpc-web fetch. We must read them
 *     **synchronously** at construction time — the bundle creates the WS
 *     synchronously and an awaitable lookup would require restructuring
 *     the bundle's own call site.
 *
 * Sync cookie lookup: tough-cookie's `CookieJar.getCookieStringSync(url)`
 * resolves the joined "k=v; k=v" header against in-memory state. The jar
 * is hydrated from the DataStore at sandbox construction (see
 * `cookie-jar.ts`) — no I/O happens during the WebSocket constructor.
 *
 * Cross-realm projection: when `ws` emits a binary message, the bytes
 * arrive as a host-realm Buffer / ArrayBuffer. The bundle's listener
 * does `e.data instanceof ArrayBuffer` against the sandbox realm's
 * ArrayBuffer constructor; a host-realm ArrayBuffer fails that check
 * silently. We copy bytes into a sandbox-realm `Uint8Array` (resolved
 * once via `sandbox.runInContext("Uint8Array")`) and hand back its
 * `.buffer` so the realm check passes.
 */
import { WebSocket as NodeWS } from "ws";
import { Shim, type ShimContext } from "./types.ts";
import type { Sandbox } from "./sandbox.ts";

export class WebSocketShim extends Shim {
  readonly name = "websocket";

  install(sandbox: Sandbox, ctx: ShimContext): void {
    // Resolve the sandbox realm's `Uint8Array` constructor once. Used to
    // project incoming binary messages so `e.data instanceof ArrayBuffer`
    // checks against the realm's own constructor pass.
    const VmU8 = sandbox.runInContext("Uint8Array") as Uint8ArrayConstructor;
    const ua = ctx.userAgent;
    const jar = ctx.jar;

    /**
     * Browser-shaped WebSocket wrapping `ws`. The constructor is
     * synchronous — cookie lookup goes through `jar.getCookieStringSync`
     * so no `await` is needed before the upgrade GET fires.
     */
    class SandboxWebSocket {
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
      onmessage: ((ev: { data: ArrayBuffer | Uint8Array | string }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

      private inner: NodeWS;
      private listeners: Map<string, Set<(ev: unknown) => void>> = new Map();

      constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        // Sync cookie lookup for the upgrade GET. Empty string is safe —
        // ws just skips the Cookie header. Errors here (malformed URL etc.)
        // resolve to empty so the connection still attempts.
        let cookieHeader = "";
        try {
          cookieHeader = jar.getCookieStringSync(url) ?? "";
        } catch {
          cookieHeader = "";
        }
        this.inner = new NodeWS(url, protocols, {
          headers: {
            "User-Agent": ua,
            Origin: "https://www.snapchat.com",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        });
        this.inner.binaryType = "arraybuffer";

        this.inner.on("open", () => {
          this.readyState = 1;
          const ev = { type: "open", target: this };
          this.onopen?.(ev);
          this.fire("open", ev);
        });
        this.inner.on("message", (data, isBinary) => {
          // ws emits Buffer for binary; convert to ArrayBuffer for browser
          // semantics. The chunk explicitly checks `e.data instanceof ArrayBuffer`.
          let normalized: ArrayBuffer | string;
          if (isBinary && Buffer.isBuffer(data)) {
            const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
            normalized = u8.buffer;
          } else if (data instanceof ArrayBuffer) {
            normalized = data;
          } else if (Buffer.isBuffer(data)) {
            normalized = data.toString("utf8");
          } else {
            // Fragments mode (Buffer[]) — unlikely for our use, but ws's
            // type union includes it. Coerce through unknown so TS doesn't
            // complain about Buffer[] ↛ ArrayBuffer.
            normalized = data as unknown as ArrayBuffer;
          }
          // Project the ArrayBuffer into the sandbox realm so cross-realm
          // `instanceof ArrayBuffer` checks pass.
          let projected: ArrayBuffer | string = normalized;
          if (normalized instanceof ArrayBuffer) {
            const inst = new VmU8(normalized.byteLength);
            inst.set(new Uint8Array(normalized));
            projected = inst.buffer;
          }
          const ev = { type: "message", data: projected, target: this };
          this.onmessage?.(ev);
          this.fire("message", ev);
        });
        this.inner.on("error", (err) => {
          const ev = { type: "error", error: err, target: this };
          this.onerror?.(ev);
          this.fire("error", ev);
        });
        this.inner.on("unexpected-response", (_req, res) => {
          const ev = {
            type: "error",
            error: new Error(`WS handshake HTTP ${res.statusCode}`),
            target: this,
          };
          this.onerror?.(ev);
          this.fire("error", ev);
        });
        this.inner.on("close", (code, reasonBuf) => {
          this.readyState = 3;
          const reason = (reasonBuf as Buffer)?.toString?.("utf8") ?? "";
          const ev = { type: "close", code, reason, wasClean: code === 1000, target: this };
          this.onclose?.(ev);
          this.fire("close", ev);
        });
      }

      send(data: ArrayBuffer | Uint8Array | string): void {
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
      private fire(type: string, ev: unknown): void {
        const set = this.listeners.get(type);
        if (!set) return;
        for (const h of set) {
          try { h(ev); } catch { /* listener throw shouldn't kill the WS */ }
        }
      }
    }

    sandbox.window.WebSocket = SandboxWebSocket;
  }
}
