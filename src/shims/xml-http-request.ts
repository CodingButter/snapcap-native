/**
 * Sandbox `XMLHttpRequest` shim — projects a streaming-binary-capable XHR
 * class onto `sandbox.window.XMLHttpRequest`, wrapping Node's native `fetch`.
 *
 * Why this exists:
 *   The accounts bundle's gRPC client (`improbable-eng/grpc-web`) picks a
 *   transport via `CrossBrowserHttpTransport`:
 *     - `detectFetchSupport()` requires `Response.prototype.hasOwnProperty("body")`.
 *       happy-dom defines `body` as an *instance* property, not on the prototype,
 *       so this returns false → fetch transport is rejected.
 *     - Falls back to `XhrTransport`, which probes
 *       `xhr.responseType = "moz-chunked-arraybuffer"` and accepts whatever
 *       sticks. happy-dom's XHR accepts ANY responseType string without
 *       validation, so improbable-eng selects the `MozChunkedArrayBufferXHR`
 *       variant. That variant reads `xhr.response` on each `progress` event
 *       and expects an `ArrayBuffer` containing JUST the latest chunk.
 *
 *   happy-dom's XHR (see `node_modules/happy-dom/lib/xml-http-request/
 *   XMLHttpRequest.js:317-360`) accumulates the entire response into a
 *   single Buffer first, sets `#responseBody` only AFTER the body stream is
 *   fully drained, and only THEN fires `load` / `loadend`. During `progress`
 *   events `xhr.response` is null, so improbable-eng's per-chunk decode
 *   gets nothing — every gRPC-Web call dies with
 *   `Response closed without grpc-status (Headers only)` because the
 *   trailer-bearing chunks never reach the framing decoder.
 *
 *   This shim mirrors the moz-chunked-arraybuffer semantic faithfully:
 *   for every chunk the Node fetch reader yields, we set
 *   `this.response` to a SANDBOX-realm `ArrayBuffer` of JUST that chunk
 *   and dispatch `progress` + `readystatechange(LOADING)`. After the last
 *   chunk we dispatch `load` + `loadend` + `readystatechange(DONE)`.
 *
 * Cross-realm `instanceof`: improbable-eng calls `new Uint8Array(e)` inside
 * the sandbox realm where `e === xhr.response`. The sandbox's `Uint8Array`
 * constructor only accepts ArrayBuffers from the same realm; a host-realm
 * ArrayBuffer triggers `TypeError: First argument to Uint8Array must be a
 * Buffer or ArrayBuffer or ArrayBufferView`. We resolve the sandbox-realm
 * `ArrayBuffer` constructor once via `sandbox.runInContext("ArrayBuffer")`
 * and allocate every chunk through it, mirroring the pattern in
 * `Sandbox.toVmU8` (sandbox.ts:225) and the WebSocket shim (websocket.ts:44).
 *
 * Cookies: when `withCredentials === true` we attach the joined cookie
 * header from the shared tough-cookie jar (the same jar that backs
 * document.cookie, the happy-dom outgoing-fetch CookieContainer, and the
 * host-realm grpc-web fetch in `transport/cookies.ts`). On response we
 * parse every `Set-Cookie` header via `getSetCookie()` — the standard
 * Node 20+ Headers API — and persist back through `persistJar`. With
 * `withCredentials === false` we attach no cookies and persist nothing,
 * matching browser semantics.
 *
 * Per-spec, `getAllResponseHeaders()` MUST NOT include `Set-Cookie` /
 * `Set-Cookie2` — browsers strip those from XHR-visible headers because
 * cookies are managed by the user agent, not script. We follow that.
 */
import type { CookieJar } from "tough-cookie";
import { Cookie } from "tough-cookie";
import { nativeFetch } from "../transport/native-fetch.ts";
import type { DataStore } from "../storage/data-store.ts";
import { log } from "../logging.ts";
import { persistJar } from "./cookie-jar.ts";
import type { Sandbox } from "./sandbox.ts";
import { Shim, type ShimContext } from "./types.ts";

/**
 * Best-effort byte count for an outgoing XHR/fetch body. Returns 0 when the
 * shape is unknown — we only log sizes, never content, so a wrong guess is
 * a metric blip, never a correctness issue.
 *
 * Covered shapes:
 *   - null / undefined → 0
 *   - string → UTF-8 byte length
 *   - ArrayBuffer / SharedArrayBuffer → byteLength
 *   - ArrayBufferView (Uint8Array, DataView, …) → byteLength
 *   - URLSearchParams → UTF-8 length of toString()
 *   - Blob (host or sandbox realm) → .size
 *   - FormData / ReadableStream → 0 (size not knowable without draining)
 */
function byteLengthOf(body: unknown): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === "string") {
    // Avoid allocating a Buffer when Bun/Node have a global TextEncoder.
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  // Duck-typed: Blob / sandbox-realm Blob both expose `.size`.
  const maybeSize = (body as { size?: unknown }).size;
  if (typeof maybeSize === "number") return maybeSize;
  return 0;
}

type EventHandler = (ev: Record<string, unknown>) => void;

/** Build the XHR class bound to the sandbox realm + cookie jar. */
function createNativeFetchXhr(opts: {
  jar: CookieJar;
  store: DataStore;
  sandbox: Sandbox;
  defaultUserAgent: string;
}): unknown {
  const { jar, store, sandbox, defaultUserAgent } = opts;

  // Resolve sandbox-realm ArrayBuffer once. Cross-realm `new Uint8Array(host
  // ArrayBuffer)` throws inside the bundle; we hand back same-realm buffers.
  const VmArrayBuffer = sandbox.runInContext("ArrayBuffer") as ArrayBufferConstructor;
  const VmUint8Array = sandbox.runInContext("Uint8Array") as Uint8ArrayConstructor;

  /** Copy host bytes into a sandbox-realm ArrayBuffer. */
  function toVmArrayBuffer(src: Uint8Array): ArrayBuffer {
    const ab = new VmArrayBuffer(src.byteLength);
    const view = new VmUint8Array(ab);
    view.set(src);
    return ab;
  }

  /** Resolve a possibly-relative URL against the sandbox's current page URL. */
  function resolveUrl(raw: string): string {
    try {
      return new URL(raw).href;
    } catch {
      const base =
        ((sandbox.window as { location?: { href?: string } }).location?.href) ??
        "https://www.snapchat.com/web";
      return new URL(raw, base).href;
    }
  }

  return class SandboxXMLHttpRequest {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;

    UNSENT = 0;
    OPENED = 1;
    HEADERS_RECEIVED = 2;
    LOADING = 3;
    DONE = 4;

    // Public XHR properties improbable-eng + the bundle touch.
    readyState = 0;
    status = 0;
    statusText = "";
    response: ArrayBuffer | string | null = null;
    responseText = "";
    responseURL = "";
    responseType: "" | "text" | "arraybuffer" | "moz-chunked-arraybuffer" | string = "";
    withCredentials = false;
    timeout = 0;

    // Property-style event handlers.
    onreadystatechange: EventHandler | null = null;
    onload: EventHandler | null = null;
    onloadend: EventHandler | null = null;
    onloadstart: EventHandler | null = null;
    onerror: EventHandler | null = null;
    onprogress: EventHandler | null = null;
    onabort: EventHandler | null = null;
    ontimeout: EventHandler | null = null;

    // Internal state.
    private method = "GET";
    private url = "";
    private requestHeaders: Array<[string, string]> = [];
    private responseHeaders: Headers | null = null;
    private listeners: Map<string, Set<EventHandler>> = new Map();
    private aborted = false;
    private abortCtrl: AbortController | null = null;

    // Observability — tracked across the request lifecycle for the
    // logging.ts net.xhr.* events. `tStart` is set at send() (not open(),
    // since open() can be many ms ahead of send() while headers are
    // attached). `reqBytes` / `respBytes` are best-effort sums.
    private tStart = 0;
    private reqBytes = 0;
    private respBytes = 0;
    // Guards against double-emitting net.xhr.done / net.xhr.error if
    // both an abort and a finalize race (shouldn't happen, but cheap).
    private logged = false;

    /** No-op stub — improbable-eng's `XHR` (text-mode) variant calls this,
     *  but happy-dom's lack of it is exactly what pushes detection toward
     *  the moz-chunked path. We don't need it; provide a stub so direct
     *  callers don't crash if they reach this branch. */
    overrideMimeType(_mime: string): void {
      /* no-op */
    }

    open(method: string, url: string, async: boolean = true, _user?: string, _password?: string): void {
      if (!async) {
        // Bundle never uses sync XHR; refuse rather than silently breaking.
        throw new Error("SandboxXMLHttpRequest: synchronous XHR not supported");
      }
      this.method = (method ?? "GET").toUpperCase();
      this.url = resolveUrl(url);
      this.requestHeaders = [];
      this.responseHeaders = null;
      this.response = null;
      this.responseText = "";
      this.responseURL = "";
      this.status = 0;
      this.statusText = "";
      this.aborted = false;
      this.abortCtrl = new AbortController();
      this.tStart = 0;
      this.reqBytes = 0;
      this.respBytes = 0;
      this.logged = false;
      this.setReadyState(1); // OPENED
    }

    setRequestHeader(name: string, value: string): void {
      if (this.readyState !== 1) {
        throw new Error("SandboxXMLHttpRequest: setRequestHeader called outside OPENED state");
      }
      this.requestHeaders.push([String(name), String(value)]);
    }

    getResponseHeader(name: string): string | null {
      if (!this.responseHeaders) return null;
      const lc = String(name).toLowerCase();
      if (lc === "set-cookie" || lc === "set-cookie2") return null;
      return this.responseHeaders.get(name);
    }

    /** CRLF-joined `Name: value` pairs, set-cookie* stripped per XHR spec. */
    getAllResponseHeaders(): string {
      if (!this.responseHeaders) return "";
      const lines: string[] = [];
      for (const [name, value] of this.responseHeaders.entries()) {
        const lc = name.toLowerCase();
        if (lc === "set-cookie" || lc === "set-cookie2") continue;
        lines.push(`${name}: ${value}`);
      }
      return lines.join("\r\n");
    }

    addEventListener(type: string, handler: EventHandler): void {
      if (typeof handler !== "function") return;
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(handler);
    }
    removeEventListener(type: string, handler: EventHandler): void {
      this.listeners.get(type)?.delete(handler);
    }

    abort(): void {
      if (this.aborted) return;
      this.aborted = true;
      try { this.abortCtrl?.abort(); } catch { /* ignore */ }
      this.setReadyState(4); // DONE per spec when aborted post-send
      this.fireEvent("abort", { loaded: 0, total: 0 });
      this.fireEvent("loadend", { loaded: 0, total: 0 });
    }

    send(body?: BodyInit | null): void {
      if (this.readyState !== 1) {
        throw new Error("SandboxXMLHttpRequest: send called before open");
      }
      // Observability — start the clock and record outgoing size BEFORE the
      // async kick. Both fields are read again at finalize/error time.
      this.tStart = performance.now();
      this.reqBytes = byteLengthOf(body ?? null);
      log({ kind: "net.xhr.open", method: this.method, url: this.url });
      // Kick off async; XHR.send() is fire-and-forget on the caller's side.
      this.runRequest(body ?? null).catch((err) => {
        // Defence in depth: runRequest already routes errors through
        // dispatchError, but a thrown synchronous error inside it (e.g. a
        // listener crashed) shouldn't escape into the unhandled-rejection
        // channel.
        this.dispatchError(err instanceof Error ? err : new Error(String(err)));
      });
    }

    private setReadyState(state: number): void {
      this.readyState = state;
      this.fireEvent("readystatechange", {});
    }

    /**
     * Dispatch to BOTH the property-style handler and any addEventListener
     * subscribers. `target`/`currentTarget` point back at this instance so
     * improbable-eng's `(e) => doStuff(e.error)` shape works.
     */
    private fireEvent(type: string, extra: Record<string, unknown>): void {
      const ev = {
        type,
        target: this,
        currentTarget: this,
        ...extra,
      };
      const propHandler = this.getPropHandler(type);
      if (propHandler) {
        try { propHandler(ev); } catch { /* listener crash isolated */ }
      }
      const set = this.listeners.get(type);
      if (set) {
        for (const h of set) {
          try { h(ev); } catch { /* listener crash isolated */ }
        }
      }
    }

    private getPropHandler(type: string): EventHandler | null {
      switch (type) {
        case "readystatechange": return this.onreadystatechange;
        case "load": return this.onload;
        case "loadend": return this.onloadend;
        case "loadstart": return this.onloadstart;
        case "error": return this.onerror;
        case "progress": return this.onprogress;
        case "abort": return this.onabort;
        case "timeout": return this.ontimeout;
        default: return null;
      }
    }

    private dispatchError(err: Error): void {
      this.status = 0;
      this.statusText = "";
      if (!this.logged) {
        this.logged = true;
        log({
          kind: "net.xhr.error",
          method: this.method,
          url: this.url,
          error: err.message,
          // tStart of 0 means send() never ran — fall back to 0ms.
          durMs: this.tStart === 0 ? 0 : performance.now() - this.tStart,
        });
      }
      this.setReadyState(4);
      this.fireEvent("error", { error: err, message: err.message });
      this.fireEvent("loadend", { loaded: 0, total: 0 });
    }

    /** Build the outgoing Headers, attaching cookies if withCredentials. */
    private buildOutgoingHeaders(): Headers {
      const h = new Headers();
      // Default UA — bundle code may not set one explicitly, and Node fetch
      // would otherwise send `node`. Match the UA the rest of the SDK uses.
      let hasUA = false;
      for (const [k, v] of this.requestHeaders) {
        h.append(k, v);
        if (k.toLowerCase() === "user-agent") hasUA = true;
      }
      if (!hasUA) h.set("User-Agent", defaultUserAgent);
      if (this.withCredentials) {
        try {
          const cookieHeader = jar.getCookieStringSync(this.url);
          if (cookieHeader) h.set("Cookie", cookieHeader);
        } catch {
          /* malformed URL or jar lookup error — proceed without cookies */
        }
      }
      return h;
    }

    /** Parse + merge response Set-Cookie headers into the shared jar. */
    private absorbSetCookies(res: Response): void {
      if (!this.withCredentials) return;
      // Headers.getSetCookie() returns string[] in Node 20+; safe to call
      // directly. Falsy/empty array → no-op.
      let setCookies: string[] = [];
      try {
        setCookies = (res.headers as Headers & { getSetCookie?: () => string[] })
          .getSetCookie?.() ?? [];
      } catch {
        setCookies = [];
      }
      if (setCookies.length === 0) return;
      let mutated = false;
      for (const raw of setCookies) {
        const parsed = Cookie.parse(raw);
        if (!parsed) continue;
        try {
          jar.setCookieSync(parsed, this.url);
          mutated = true;
        } catch {
          /* per-cookie rejection (public-suffix, expired, etc.) */
        }
      }
      if (mutated) persistJar(jar, store);
    }

    private async runRequest(body: BodyInit | null): Promise<void> {
      // Convert sandbox-realm Uint8Array bodies — Node fetch in the host
      // realm accepts these; no conversion needed. AbortSignal from our
      // host-realm controller flows through unchanged.
      const headers = this.buildOutgoingHeaders();
      let res: Response;
      try {
        res = await nativeFetch(this.url, {
          method: this.method,
          headers,
          body: this.method === "GET" || this.method === "HEAD" ? undefined : (body as BodyInit | null | undefined),
          signal: this.abortCtrl?.signal,
          // We handle cookies ourselves; the underlying fetch doesn't have
          // a jar so credentials:"include" would be a no-op anyway.
          redirect: "follow",
        });
      } catch (err) {
        if (this.aborted) return; // abort() already fired the events
        this.dispatchError(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (this.aborted) return;

      this.status = res.status;
      this.statusText = res.statusText ?? "";
      this.responseURL = res.url ?? this.url;
      this.responseHeaders = res.headers;
      this.absorbSetCookies(res);

      // HEADERS_RECEIVED — improbable-eng's onStateChange() reads
      // getAllResponseHeaders() + status here.
      this.setReadyState(2);

      const total = (() => {
        const cl = res.headers.get("content-length");
        if (!cl) return 0;
        const n = Number(cl);
        return Number.isFinite(n) ? n : 0;
      })();

      // Stream the body. moz-chunked-arraybuffer semantic: each progress
      // event sees `xhr.response` set to JUST the latest chunk. For other
      // response types we accumulate into a final value at DONE.
      const isMozChunked = this.responseType === "moz-chunked-arraybuffer";
      const chunks: Uint8Array[] = [];
      let loaded = 0;

      if (!res.body) {
        // No body stream — go straight to DONE with whatever response shape.
        this.finalizeBody(chunks, isMozChunked, loaded, total);
        return;
      }

      const reader = res.body.getReader();
      try {
        // Drain loop. Each chunk: project into sandbox realm, set this.response
        // to that chunk only (moz semantic), fire progress + LOADING.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.aborted) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return;
          }
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
          loaded += chunk.byteLength;
          this.respBytes += chunk.byteLength;
          if (isMozChunked) {
            this.response = toVmArrayBuffer(chunk);
          } else {
            chunks.push(chunk);
          }
          this.readyState = 3; // LOADING
          this.fireEvent("progress", { loaded, total, lengthComputable: total > 0 });
          this.fireEvent("readystatechange", {});
        }
      } catch (err) {
        if (this.aborted) return;
        this.dispatchError(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.finalizeBody(chunks, isMozChunked, loaded, total);
    }

    /** Set the final `response` payload and fire DONE/load/loadend. */
    private finalizeBody(
      chunks: Uint8Array[],
      isMozChunked: boolean,
      loaded: number,
      total: number,
    ): void {
      if (!isMozChunked) {
        // Concat collected chunks into the final response per responseType.
        let totalLen = 0;
        for (const c of chunks) totalLen += c.byteLength;
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        if (this.responseType === "arraybuffer") {
          this.response = toVmArrayBuffer(merged);
        } else if (this.responseType === "" || this.responseType === "text") {
          const text = new TextDecoder("utf-8").decode(merged);
          this.responseText = text;
          this.response = text;
        } else if (this.responseType === "json") {
          const text = new TextDecoder("utf-8").decode(merged);
          try {
            this.response = JSON.parse(text);
          } catch {
            this.response = null;
          }
        } else {
          // Unknown responseType — hand back an ArrayBuffer for safety.
          this.response = toVmArrayBuffer(merged);
        }
      }
      // Observability — emit net.xhr.done before user-visible event firing
      // so log timing reflects when the body fully arrived (listeners may
      // run other I/O that distorts the duration). gRPC-Web puts trailers
      // in the body frame too, but headers are sufficient for status.
      if (!this.logged) {
        this.logged = true;
        const headers = this.responseHeaders;
        const grpcStatus = headers?.get("grpc-status") ?? undefined;
        const grpcMessage = headers?.get("grpc-message") ?? undefined;
        log({
          kind: "net.xhr.done",
          method: this.method,
          url: this.url,
          status: this.status,
          reqBytes: this.reqBytes,
          respBytes: this.respBytes,
          durMs: this.tStart === 0 ? 0 : performance.now() - this.tStart,
          ...(grpcStatus !== undefined ? { grpcStatus } : {}),
          ...(grpcMessage !== undefined ? { grpcMessage } : {}),
        });
      }
      // For moz-chunked, final response stays as the last chunk (what improbable-eng
      // expects — it doesn't read response after onLoadEvent).
      this.readyState = 4; // DONE
      this.fireEvent("readystatechange", {});
      this.fireEvent("load", { loaded, total, lengthComputable: total > 0 });
      this.fireEvent("loadend", { loaded, total, lengthComputable: total > 0 });
    }
  };
}

/**
 * `Shim`-shaped wrapper. Overwrites the sandbox's `window.XMLHttpRequest`
 * — which `BROWSER_PROJECTED_KEYS` populated with happy-dom's broken
 * implementation — with a streaming-binary-capable XHR backed by Node's
 * native fetch. Last-write-wins ordering: this runs after the projection
 * loop in `Sandbox`'s constructor, so happy-dom's XHR is silently replaced
 * before any bundle code runs.
 */
export class XmlHttpRequestShim extends Shim {
  readonly name = "xml-http-request";

  install(sandbox: Sandbox, ctx: ShimContext): void {
    sandbox.window.XMLHttpRequest = createNativeFetchXhr({
      jar: ctx.jar,
      store: ctx.dataStore,
      sandbox,
      defaultUserAgent: ctx.userAgent,
    });
  }
}
