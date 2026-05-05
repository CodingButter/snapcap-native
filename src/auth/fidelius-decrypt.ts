/**
 * Inbound message decrypt — bundle-driven.
 *
 * Brings up Snap's own messaging session inside the same `vm.Context`
 * that hosts the standalone chat WASM (booted by `fidelius-mint.ts`),
 * patches the f16f14e3 worker chunk to expose its `En` engine + `un`
 * env, then calls `En.createMessagingSession(...)`. The chunk's own
 * duplex client opens the WS to `aws.duplex.snapchat.com`, subscribes
 * to the inbound stream; messages flow → WASM decrypts → the wrapped
 * `messagingDelegate.onMessageReceived(t)` fires with `t.content` as
 * plaintext bytes.
 *
 * Mechanism summary:
 *
 *   1. Reuse the cached realm from `getStandaloneChatRealm()` — Module
 *      is already up with all 74 Embind classes registered.
 *   2. Project a Node-`ws`-backed `WebSocket` shim + `importScripts`
 *      stub onto the realm's globalThis. Pre-bind cookies for the WS
 *      upgrade GET (the duplex client can't await in its constructor).
 *   3. Source-patch `f16f14e3b729db223348.chunk.js` to expose `En` /
 *      `un` / `pn` on globalThis BEFORE its `z(En)` Comlink call. Eval
 *      the patched chunk in the realm.
 *   4. Inject our pre-built Module into `un.wasmModule` via `pn`. Init
 *      Platform / ConfigRegistry / GrpcManager (the WASM-side services
 *      the chunk would normally init from a worker bootstrap). Wire
 *      GrpcManager's web factory through native fetch + cookie jar so
 *      Fidelius gateway calls pass under the SDK's auth.
 *   5. Wrap `Module.messaging_Session.create` arg slot 9 (the
 *      messagingDelegate) so `onMessageReceived` / `onMessagesReceived`
 *      forward `t.content` to the caller's `onPlaintext`.
 *   6. Call `En.setAuthTokenGetter(() => bearer)`,
 *      `En.setMcsCofSequenceIdsGetter(() => [])`, then
 *      `En.createMessagingSession(...18 args)`. Pulse `reachabilityChanged(true)`
 *      + `appStateChanged(ACTIVE)` to wake the session.
 *   7. Pump the inbox: `enterConversation(...)` +
 *      `fetchConversationWithMessages(...)` per conv → WASM decrypts
 *      cached messages → wrapped delegate fires.
 *
 * @internal Auth-layer; called from `api/messaging.ts`'s lazy bring-up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { WebSocket as NodeWS } from "ws";
import type { CookieJar } from "tough-cookie";
import type {
  StandaloneChatRealm,
  StandaloneChatModule,
} from "./fidelius-mint.ts";
import { nativeFetch } from "../transport/native-fetch.ts";

/**
 * Plaintext message handed to the consumer's `onPlaintext` callback.
 *
 * `content` is the decrypted bytes the WASM produced for `t.content`
 * inside the messagingDelegate. For text DMs it's a UTF-8 string of the
 * sent text. For media messages it's a small protobuf header pointing
 * at the encrypted CDN blob.
 */
export type PlaintextMessage = {
  /** Decrypted message bytes the WASM produced. */
  content: Uint8Array;
  /** True iff WE are the sender (outbound); false for inbound from peer. */
  isSender: boolean | undefined;
  /** Snap's contentType enum (2 = text, 3 = media, …). */
  contentType: number | undefined;
  /** Raw delegate object for advanced callers — keys vary by build. */
  raw: Record<string, unknown>;
};

/**
 * Options for {@link setupBundleSession}.
 */
export type SetupBundleSessionOpts = {
  /** Standalone-WASM payload from `getStandaloneChatRealm()`. */
  realm: StandaloneChatRealm;
  /** Active SSO bearer (Zustand `auth.authToken.token`). */
  bearer: string;
  /**
   * Cookie jar used for WS-upgrade and gRPC requests. Tough-cookie's
   * shared jar from `getOrCreateJar(dataStore)`.
   */
  cookieJar: CookieJar;
  /**
   * UA string the Snap web client uses; passed to WS upgrade headers
   * and gRPC requests.
   */
  userAgent: string;
  /**
   * Our Snap userId as a UUID string (`"527be2ff-aaec-4622-9c68-…"`).
   * Used to build `clientCfg.userId` and the session's
   * `getAuthContextDelegate.getAuthContext`.
   */
  userId: string;
  /**
   * Conversation IDs (UUID strings) to enter + pull message history
   * for after the session bootstraps. Empty = wait passively for
   * live frames only.
   */
  conversationIds?: readonly string[];
  /**
   * Called every time the wrapped messaging delegate produces a
   * plaintext message. May fire many times per session.
   */
  onPlaintext: (msg: PlaintextMessage) => void;
  /**
   * Called once, after `En.createMessagingSession(...)` resolves, with
   * the bundle-realm session object. Consumers (e.g. `Messaging.sendText`)
   * hold the reference to drive outbound `sendMessageWithContent` calls
   * via the session's `getConversationManager()` / `getSnapManager()`.
   *
   * Optional — leave unset if the caller only wants inbound decrypt.
   */
  onSession?: (session: BundleMessagingSession) => void;
  /** Called for diagnostic events. Defaults to `process.stderr.write`. */
  log?: (line: string) => void;
  /**
   * Override path to the Snap bundle dir (the one containing
   * `cf-st.sc-cdn.net/dw/`). Defaults to the SDK's `vendor/snap-bundle`.
   */
  bundleDir?: string;
  /**
   * Optional DataStore for cross-run persistence of the bundle's
   * `userDataStore` slots (`e2eeIdentityKey`, `e2eeTempKey`). Without
   * persistence the WASM mints a FRESH Fidelius identity every run,
   * which:
   *   1) Re-registers via InitializeWebKey (cheap but wasteful)
   *   2) Loses the ability to decrypt messages encrypted to OUR
   *      previous public key — those messages report
   *      `decrypt_failure: "CEK_ENTRY_NOT_FOUND"` and the WASM hands
   *      the messagingDelegate an analytics struct with empty content.
   * Pass the same DataStore the SDK uses for its cookie jar to keep
   * the identity stable across script restarts.
   */
  dataStore?: {
    get(k: string): Promise<Uint8Array | undefined>;
    set(k: string, v: Uint8Array): Promise<void>;
    delete(k: string): Promise<void>;
    keys?: (prefix?: string) => string[];
  };
};

/**
 * Tear-down handle returned by {@link setupBundleSession}. Currently a
 * no-op disposer (the bundle's session lives for the process lifetime
 * once started); reserved for future explicit teardown.
 */
export type BundleSessionDisposer = () => void;

/**
 * The bundle-realm WASM messaging session — Embind-bound, methods include
 * `getConversationManager()`, `getSnapManager()`, `getFeedManager()`,
 * `reachabilityChanged(b)`, `appStateChanged(state)`, etc.
 *
 * Surfaced via {@link SetupBundleSessionOpts.onSession} so outbound send
 * methods on `Messaging` can drive `sendMessageWithContent` directly.
 */
export type BundleMessagingSession = Record<string, Function>;

type EmModule = {
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  HEAPU8: Uint8Array;
  abort?: (what?: unknown) => void;
  [k: string]: unknown;
};

/**
 * Boot Snap's messaging session inside the standalone-WASM mint realm
 * and stream decrypted inbound messages to `opts.onPlaintext`.
 *
 * @param opts - Session setup parameters; see {@link SetupBundleSessionOpts}.
 * @returns A disposer (currently a no-op — the bundle session is
 *   process-lifetime).
 *
 * @throws If the f16f14e3 chunk patch site has shifted (Snap rebuilt
 *   the bundle), if `En.createMessagingSession` rejects, or if the WS
 *   upgrade fails inside the chunk's duplex client.
 */
export async function setupBundleSession(
  opts: SetupBundleSessionOpts,
): Promise<BundleSessionDisposer> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const bundleDir =
    opts.bundleDir ?? join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");
  const chunkPath = join(chatDw, "f16f14e3b729db223348.chunk.js");
  const chunk7818Path = join(chatDw, "06c27f3bcaa1e5c47eea.chunk.js");

  const { moduleEnv, context, wreq } = opts.realm;
  void wreq;
  const Module = moduleEnv as unknown as EmModule;
  if (!Module || typeof Module._malloc !== "function") {
    throw new Error("setupBundleSession: moduleEnv missing _malloc — WASM not booted");
  }
  if (typeof (Module as Record<string, unknown>).messaging_Session !== "function") {
    throw new Error(
      "setupBundleSession: moduleEnv.messaging_Session not registered — Embind shape may have shifted",
    );
  }
  // Cross-realm constructors so cross-realm `instanceof` checks pass
  // inside the chunk and the WASM Embind layer.
  const VmU8 = vm.runInContext("Uint8Array", context) as Uint8ArrayConstructor;
  const VmMap = vm.runInContext("Map", context) as MapConstructor;

  // ── Realm globals the chunk's runtime + duplex client need ─────────
  // Most are already populated by fidelius-mint's bootStandaloneMintWasm,
  // but the worker chunk reads `self.X` for several things mint never
  // touches (WebSocket, importScripts, self.addEventListener for the
  // freeze handler that registers cr()._close()). Set them on the
  // realm's global.
  const realmGlobal = vm.runInContext("globalThis", context) as Record<string, unknown>;

  // Worker-only event APIs the chunk pokes at near top-level. Mint's
  // bootStandaloneMintWasm doesn't install these (mint never runs
  // worker code). Provide no-op stubs so `self.addEventListener("freeze",
  // …)` and similar don't throw.
  if (typeof realmGlobal.addEventListener !== "function") {
    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    realmGlobal.addEventListener = (type: string, handler: (ev: unknown) => void): void => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    };
    realmGlobal.removeEventListener = (type: string, handler: (ev: unknown) => void): void => {
      listeners.get(type)?.delete(handler);
    };
    realmGlobal.dispatchEvent = (_ev: unknown): boolean => true;
  }
  // Some bundle code probes for `Worker` / `Blob` / `URL.createObjectURL`
  // even when running on the main thread. Stub minimally so `typeof X
  // === "function"` checks pass.
  if (typeof realmGlobal.Worker !== "function") {
    realmGlobal.Worker = function WorkerStub() {
      throw new Error("Worker unavailable in fidelius-decrypt realm");
    };
  }
  // CustomEvent + Event stubs — chat-bundle module 89588 (Zustand
  // subscribe-with-CustomEvent dispatcher) reaches for `CustomEvent`
  // when reachModule traverses module 56639's dep graph during a send.
  // Provide minimal stubs; the bundle only constructs and dispatches
  // these to no-op listener buckets.
  if (typeof realmGlobal.CustomEvent !== "function") {
    realmGlobal.CustomEvent = class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
  if (typeof realmGlobal.Event !== "function") {
    realmGlobal.Event = class Event {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
  }
  if (typeof realmGlobal.EventTarget !== "function") {
    realmGlobal.EventTarget = class EventTarget {
      #l = new Map<string, Set<(ev: unknown) => void>>();
      addEventListener(type: string, h: (ev: unknown) => void): void {
        if (!this.#l.has(type)) this.#l.set(type, new Set());
        this.#l.get(type)!.add(h);
      }
      removeEventListener(type: string, h: (ev: unknown) => void): void {
        this.#l.get(type)?.delete(h);
      }
      dispatchEvent(_ev: unknown): boolean { return true; }
    };
  }
  // Beef up the document stub — chat-bundle module 89588 + descendants
  // reach for hasFocus / visibilityState / readyState / addEventListener
  // / removeEventListener at module-eval time. The mint realm's bare
  // document was minimal; add the rest so wreq("56639") and friends can
  // resolve their dep graphs without throwing.
  const docAny = realmGlobal.document as Record<string, unknown> | undefined;
  if (docAny) {
    if (typeof docAny.hasFocus !== "function") docAny.hasFocus = () => true;
    if (typeof docAny.visibilityState !== "string") docAny.visibilityState = "visible";
    if (typeof docAny.readyState !== "string") docAny.readyState = "complete";
    if (typeof docAny.addEventListener !== "function") {
      docAny.addEventListener = () => {};
      docAny.removeEventListener = () => {};
    }
    if (typeof docAny.dispatchEvent !== "function") docAny.dispatchEvent = () => true;
    // createElement returning null breaks chat-bundle init paths that
    // probe `"onreadystatechange" in c.createElement("script")` for
    // legacy IE detection, then walk the result. Return a per-tag
    // object stub with the slots most-likely consumed.
    docAny.createElement = (tag: string): Record<string, unknown> => ({
      tagName: typeof tag === "string" ? tag.toUpperCase() : "DIV",
      onreadystatechange: null,
      onload: null,
      onerror: null,
      style: {},
      setAttribute: () => {},
      getAttribute: () => null,
      removeAttribute: () => {},
      appendChild: (c: unknown) => c,
      removeChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      cloneNode: () => ({}),
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false,
        toggle: () => false,
      },
      // commonly-poked slots
      src: "",
      innerHTML: "",
      textContent: "",
    });
    if (typeof docAny.createElementNS !== "function") {
      docAny.createElementNS = (_ns: string, tag: string) => (docAny.createElement as Function)(tag);
    }
  }
  // window-level focus / blur listeners — same purpose. Some module
  // factories register synchronous addEventListener at top-level.
  if (typeof realmGlobal.onfocus !== "function") realmGlobal.onfocus = null;
  if (typeof realmGlobal.onblur !== "function") realmGlobal.onblur = null;
  // BroadcastChannel — Snap's bundle uses it for cross-tab Zustand sync
  // when present. Provide a no-op so module init doesn't throw.
  if (typeof realmGlobal.BroadcastChannel !== "function") {
    realmGlobal.BroadcastChannel = class BroadcastChannel {
      name: string;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      constructor(name: string) { this.name = name; }
      postMessage(_data: unknown): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    };
  }
  // requestIdleCallback — chat bundle uses this for background tasks.
  if (typeof realmGlobal.requestIdleCallback !== "function") {
    realmGlobal.requestIdleCallback = (cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void): number => {
      return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0) as unknown as number;
    };
    realmGlobal.cancelIdleCallback = (id: number): void => clearTimeout(id as unknown as NodeJS.Timeout);
  }
  // Blob shim — Node 18+ exposes `globalThis.Blob`. The bundle's media
  // send pipeline (sendImage / sendSnap / stories.post) constructs Blobs
  // and reads `.size` / `.type` / `.arrayBuffer()`, all of which Node's
  // Blob supports. Project the host-realm Blob into the standalone realm
  // so the bundle's `instanceof Blob` checks (where present) pass.
  if (typeof realmGlobal.Blob !== "function" && typeof globalThis.Blob === "function") {
    realmGlobal.Blob = globalThis.Blob;
  }
  // URL.createObjectURL stub — only one bundle path uses it (audio note).
  // For image / snap / story sends it's not strictly required, but a stub
  // prevents `URL.createObjectURL is not a function` crashes if the
  // bundle's pg helper ever lands on the createObjectURL fallback branch.
  const realmURL = realmGlobal.URL as { createObjectURL?: Function; revokeObjectURL?: Function } | undefined;
  if (realmURL && typeof realmURL.createObjectURL !== "function") {
    realmURL.createObjectURL = (_blob: unknown): string => "blob:snapcap-stub";
    realmURL.revokeObjectURL = (_url: string): void => {};
  }
  if (!realmGlobal.MessageChannel) {
    // Tiny synchronous stub. The chunk constructs MessageChannel for its
    // own internal Comlink-style port pair when it can't see a worker;
    // we don't actually deliver messages — just return a port pair shape.
    realmGlobal.MessageChannel = function MessageChannel(this: Record<string, unknown>) {
      const port1 = {
        postMessage: () => {},
        close: () => {},
        start: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        onmessage: null,
        onmessageerror: null,
      };
      const port2 = { ...port1 };
      this.port1 = port1;
      this.port2 = port2;
    };
  }

  // ── Pre-bind cookies for the WS upgrade GET ────────────────────────
  // The duplex client constructs `new WebSocket(url, [...])` synchronously;
  // it can't await a cookie lookup. Pre-fetch the cookie header here so
  // the WS shim's ctor can pull it inline.
  const preboundCookies = await opts.cookieJar.getCookieString(
    "https://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect",
  );

  class WebSocketShim {
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
          "User-Agent": opts.userAgent,
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
          const sz = typeof normalized === "string" ? normalized.length : (normalized as ArrayBuffer).byteLength;
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
  }
  realmGlobal.WebSocket = WebSocketShim;

  // ── importScripts shim that loads sibling chunks from disk ─────────
  const KNOWN_CHUNKS: Record<string, string> = {
    "dw/06c27f3bcaa1e5c47eea.chunk.js": chunk7818Path,
  };
  realmGlobal.importScripts = (...urls: string[]): void => {
    for (const url of urls) {
      let p: string | undefined;
      for (const key in KNOWN_CHUNKS) {
        if (url.endsWith(key)) {
          p = KNOWN_CHUNKS[key]!;
          break;
        }
      }
      if (!p) {
        log(`[importScripts] WARN unknown URL ${url}`);
        continue;
      }
      const src = readFileSync(p, "utf8");
      vm.runInContext(src, context, { filename: p.split("/").pop()! });
    }
  };

  // ── Source-patch f16f14e3 chunk: expose En + un + pn before z(En) ──
  let chunkSrc = readFileSync(chunkPath, "utf8");
  const PATCH_SITE = `wasm_worker_initialized"}),z(En)`;
  if (!chunkSrc.includes(PATCH_SITE)) {
    throw new Error(
      "setupBundleSession: f16f14e3 chunk patch site `wasm_worker_initialized\"}),z(En)` missing — bundle version may have shifted",
    );
  }
  chunkSrc = chunkSrc.replace(
    PATCH_SITE,
    `wasm_worker_initialized"}),globalThis.__SNAPCAP_EN=En,globalThis.__SNAPCAP_UN=un,globalThis.__SNAPCAP_PN=pn,z(En)`,
  );

  const wrappedChunk =
    `(function(module, exports, require) {\n` +
    chunkSrc +
    `\n})({ exports: {} }, {}, function() { throw new Error("require not available (f16f14e3 chunk)"); });`;

  try {
    vm.runInContext(wrappedChunk, context, { filename: "f16f14e3-patched.js" });
  } catch (e) {
    log(`[fidelius-decrypt] chunk run threw: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 200));

  type EnEngine = {
    setAuthTokenGetter: (g: () => Promise<string> | string) => void;
    setMcsCofSequenceIdsGetter: (g: () => Promise<unknown[]> | unknown[]) => void;
    createMessagingSession: (...a: unknown[]) => Promise<Record<string, Function>>;
    onNetworkStatusChange?: (status: string) => void;
    registerDuplexHandler?: (
      path: string,
      handler: { onReceive: (bytes: Uint8Array) => void },
    ) => unknown;
  };
  const En = realmGlobal.__SNAPCAP_EN as EnEngine | undefined;
  const un = realmGlobal.__SNAPCAP_UN as Record<string, unknown> | undefined;
  const pn = realmGlobal.__SNAPCAP_PN as ((slot: string) => (val: unknown) => void) | undefined;
  if (!En) {
    throw new Error("setupBundleSession: chunk did not expose En — patch may have failed");
  }

  // [TRACE-INSTRUMENTATION] — wrap En.registerDuplexHandler so we observe
  // every duplex registration the bundle (or our presence-bridge) requests
  // AND every send() invoked on the returned handle. Removable in one
  // commit by deleting this block.
  type DuplexHandlerHandleLike = {
    send?: (channel: string, bytes: Uint8Array) => unknown;
    unregisterHandler?: () => void;
  } & Record<string, unknown>;
  if (typeof En.registerDuplexHandler === "function") {
    const origReg = En.registerDuplexHandler.bind(En);
    En.registerDuplexHandler = ((path: string, handler: { onReceive: (bytes: Uint8Array) => void }) => {
      process.stderr.write(`[trace.chat-loader.En.registerDuplexHandler] ENTER path=${path} handlerKeys=[${handler ? Object.keys(handler).join(",") : "?"}]\n`);
      // Wrap onReceive so inbound frames coming up from the standalone
      // duplex are visible at this layer too.
      const wrappedHandler = {
        onReceive: (bytes: Uint8Array): void => {
          process.stderr.write(`[trace.chat-loader.En.handler.onReceive] path=${path} bytes=${bytes?.byteLength ?? "?"}\n`);
          try { handler.onReceive(bytes); }
          catch (e) {
            process.stderr.write(`[trace.chat-loader.En.handler.onReceive] inner threw=${(e as Error).message?.slice(0, 200)}\n`);
          }
        },
      };
      const result = origReg(path, wrappedHandler) as DuplexHandlerHandleLike | Promise<DuplexHandlerHandleLike>;
      const wrapHandle = (h: DuplexHandlerHandleLike): DuplexHandlerHandleLike => {
        if (!h || typeof h !== "object") {
          process.stderr.write(`[trace.chat-loader.En.registerDuplexHandler] RESULT non-object path=${path} type=${typeof h}\n`);
          return h;
        }
        const handleKeys = Object.keys(h).join(",");
        process.stderr.write(`[trace.chat-loader.En.registerDuplexHandler] RESULT path=${path} handle.keys=[${handleKeys}]\n`);
        if (typeof h.send === "function") {
          const origSend = h.send.bind(h);
          h.send = ((channel: string, bytes: Uint8Array): unknown => {
            process.stderr.write(`[trace.chat-loader.En.handle.send] ENTER path=${path} channel=${channel} bytes=${bytes?.byteLength ?? "?"}\n`);
            try {
              const r = origSend(channel, bytes);
              process.stderr.write(`[trace.chat-loader.En.handle.send] EXIT path=${path} channel=${channel} ret=${typeof r}\n`);
              return r;
            } catch (e) {
              process.stderr.write(`[trace.chat-loader.En.handle.send] THREW path=${path} channel=${channel} err=${(e as Error).message?.slice(0, 200)}\n`);
              throw e;
            }
          }) as typeof h.send;
        } else {
          process.stderr.write(`[trace.chat-loader.En.registerDuplexHandler] RESULT path=${path} HAS NO send() method!\n`);
        }
        return h;
      };
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<DuplexHandlerHandleLike>).then(wrapHandle);
      }
      return wrapHandle(result as DuplexHandlerHandleLike);
    }) as typeof En.registerDuplexHandler;
    process.stderr.write(`[trace.chat-loader.En.registerDuplexHandler] WRAP-INSTALLED on globalThis.__SNAPCAP_EN\n`);
  } else {
    process.stderr.write(`[trace.chat-loader.En.registerDuplexHandler] NOT A FUNCTION — cannot wrap (typeof=${typeof En.registerDuplexHandler})\n`);
  }
  // [/TRACE-INSTRUMENTATION]

  // ── Wrap messaging_Session.create to capture decrypted messages ────
  // Per recovered v3 reverse-engineering, arg slot 9 of Sess.create is
  // the messagingDelegate. The chunk's own wrapper at that slot routes
  // analytics (cn(e, [msg])); we wrap it on top so plaintext lands in
  // the consumer's onPlaintext.
  const SessAny = (Module as Record<string, unknown>).messaging_Session as
    & (new (...a: unknown[]) => unknown)
    & Record<string, unknown>;
  const Sess = SessAny as unknown as Record<string, Function>;
  if (typeof Sess.create !== "function") {
    throw new Error("setupBundleSession: Module.messaging_Session.create not a function");
  }
  const origCreate = Sess.create.bind(Sess);
  const sessionStartMs = Date.now();
  // Hold a session reference for the live-push fetch path. Captured the
  // first time createMessagingSession resolves; the wrapped delegate
  // hooks reach for it to call cm.fetchMessage by analyticsMessageId.
  let capturedSession: Record<string, Function> | undefined;
  // Dedupe analyticsMessageId fetches — the WS push fires the same id
  // multiple times per delivery (analytics retry, batch echoes, etc.).
  const fetchedAnalyticsIds = new Set<string>();

  // Factory-wrapper builder. Slot 9 of messaging_Session.create can be
  // either a FACTORY (`function(e){return {onMessageReceived: ...}}`,
  // which is what the bundle's chunk passes — Embind invokes the factory
  // with a session-context arg and uses the returned object) or a plain
  // delegate object (callers that pre-build the delegate). We handle both
  // shapes by wrapping the relevant onMessageReceived / onMessagesReceived
  // slots so plaintext lands in `opts.onPlaintext`.
  const buildHookedDelegate = (orig: Record<string, unknown>): Record<string, unknown> => {
    const origOnMR = (orig.onMessageReceived as Function | undefined)?.bind(orig);
    const origOnMsR = (orig.onMessagesReceived as Function | undefined)?.bind(orig);
    return {
      ...orig,
      onMessageReceived: (t: unknown) => {
        if (process.env.SNAPCAP_DEBUG_WORKER) {
          const elapsed = Date.now() - sessionStartMs;
          const obj = t as Record<string, unknown>;
          log(`[hook.onMessageReceived] @${elapsed}ms isSender=${obj?.isSender} ct=${obj?.contentType} hasContent=${!!obj?.content}`);
        }
        if (process.env.SNAPCAP_PROBE_CONVMGR && t && typeof t === "object") {
          const obj = t as Record<string, unknown>;
          log(`[probe.t] keys=${Object.keys(obj).join(",")} sample=${safeStringifyVal(obj).slice(0, 400)}`);
        }
        handlePushMessage(t);
        try { origOnMR?.(t); } catch (e) {
          log(`[hook.onMessageReceived] orig threw ${(e as Error).message}`);
        }
      },
      onMessagesReceived: (ts: unknown) => {
        if (process.env.SNAPCAP_DEBUG_WORKER) {
          const elapsed = Date.now() - sessionStartMs;
          log(`[hook.onMessagesReceived] @${elapsed}ms len=${Array.isArray(ts) ? ts.length : "?"}`);
        }
        if (Array.isArray(ts)) {
          for (const m of ts) handlePushMessage(m);
        }
        try { origOnMsR?.(ts); } catch (e) {
          log(`[hook.onMessagesReceived] orig threw ${(e as Error).message}`);
        }
      },
    };
  };

  // Push-path handler: deliver if the delegate already carries plaintext
  // (cached history surfaces with `m.content` populated), otherwise pull
  // the body from the bundle by analyticsMessageId via cm.fetchMessage —
  // the bundle's WASM runs the Fidelius decrypt + cleartext-body lookup
  // and hands us the unified plaintext message proto.
  const handlePushMessage = (m: unknown): void => {
    if (!m || typeof m !== "object") return;
    const obj = m as Record<string, unknown>;
    const content = obj.content;
    const hasBytes = !!(content && (content as Uint8Array).byteLength > 0);
    if (process.env.SNAPCAP_DEBUG_WORKER) {
      const keys = Object.keys(obj).slice(0, 30).join(",");
      const cid = (obj.conversationId as { id?: unknown })?.id ?? obj.conversationId;
      const md = obj.conversationMetricsData as { conversationId?: unknown } | undefined;
      const cidFromMd = (md?.conversationId as { id?: unknown })?.id ?? md?.conversationId;
      log(`[handlePush] hasBytes=${hasBytes} cid=${safeStringifyVal(cid).slice(0,60)} cidMd=${safeStringifyVal(cidFromMd).slice(0,60)} keys=${keys}`);
    }
    if (hasBytes) {
      // Cached history path — the analytics-style record actually carries
      // plaintext bytes already. Surface verbatim.
      deliverPlaintext(m, opts.onPlaintext, log);
      return;
    }
    // Live-push notification with empty content. Resolve via convMgr.
    fetchPushBody(obj);
  };

  Sess.create = function patchedCreate(...a: unknown[]) {
    const slot9 = a[9];
    if (typeof slot9 === "function") {
      // Factory: wrap so we hook the delegate the factory returns.
      const origFactory = slot9 as (...fargs: unknown[]) => unknown;
      a[9] = (...fargs: unknown[]) => {
        const built = origFactory(...fargs);
        if (built && typeof built === "object") {
          return buildHookedDelegate(built as Record<string, unknown>);
        }
        return built;
      };
    } else if (slot9 && typeof slot9 === "object") {
      a[9] = buildHookedDelegate(slot9 as Record<string, unknown>);
    }
    return origCreate(...a);
  };

  // Live-push body fetch. Snap's messaging delegate fires with empty
  // `content` for live WS push — the analytics-style record carries
  // metadata only (analyticsMessageId / conversationMetricsData /
  // decryptResult). The actual decrypted body is reachable via the
  // bundle's `convMgr.fetchMessage(...)` / `fetchMessageByServerId(...)`
  // — the same call Snap's web UI uses to render the message body after
  // a push notification. We deduplicate per analyticsMessageId so the
  // WS retry frames don't fire repeated fetches.
  const fetchPushBody = (obj: Record<string, unknown>): void => {
    if (!capturedSession) return; // session not yet ready — drop
    const cm = (capturedSession.getConversationManager as Function | undefined)?.();
    if (!cm) return;
    const cmAny = cm as Record<string, Function>;

    // Pull conversationId from conversationMetricsData.conversationId.
    const cmd = obj.conversationMetricsData as { conversationId?: unknown } | undefined;
    const convIdAny = cmd?.conversationId;
    const convIdBytes = coerceIdBytes(convIdAny, VmU8);
    if (!convIdBytes) return;

    // Pull message identifier. The analytics record carries
    // `analyticsMessageId` as a UUID string (e.g.
    // "00000000-0000-0008-AB17-E6B2F4F7DD75") — the high 8 bytes encode
    // the server message id, low 8 bytes are conv-id-tail. Use the
    // attemptId (a 16-byte client UUID) as the dedupe key + raw id.
    const aid = obj.analyticsMessageId;
    const dedupeKey = typeof aid === "string"
      ? aid
      : safeStringifyVal(aid).slice(0, 80);
    if (fetchedAnalyticsIds.has(dedupeKey)) return;
    fetchedAnalyticsIds.add(dedupeKey);
    // Cap dedupe set so we don't grow unboundedly.
    if (fetchedAnalyticsIds.size > 5000) {
      const first = fetchedAnalyticsIds.values().next().value as string | undefined;
      if (first) fetchedAnalyticsIds.delete(first);
    }

    const onResult = (msg: unknown): void => {
      if (msg && typeof msg === "object") {
        deliverPlaintext(msg, opts.onPlaintext, log);
      }
    };

    // Strategy: trigger `fetchConversationWithMessages` on the conv. The
    // bundle's WASM re-decrypts that conv's recent messages and re-fires
    // OUR ALREADY-WRAPPED `messagingDelegate.onMessagesReceived` with
    // populated `m.content` — same callback the cached-history path uses
    // at session start. We don't need a separate callback wrapper here;
    // the existing wrap surfaces decrypted content via deliverPlaintext
    // automatically.
    //
    // (Earlier we tried `fetchMessage(convId, aid, cb)` directly but the
    // bundle's signature wants an int64 server message id, not the
    // analytics UUID — wrong shape, threw repeatedly. The conv-level
    // re-fetch is simpler and uses the path we already proved works.)
    if (typeof cmAny.fetchConversationWithMessages === "function") {
      try {
        cmAny.fetchConversationWithMessages(
          { id: convIdBytes },
          {
            onFetchConversationWithMessagesComplete: (
              _conv: unknown,
              messages: unknown,
              _hasMore: unknown,
            ) => {
              if (Array.isArray(messages)) {
                for (const m of messages) deliverPlaintext(m, opts.onPlaintext, log);
              }
            },
            onError: (...a: unknown[]) =>
              log(`[fetchPushBody.onError] ${safeStringifyVal(a).slice(0, 200)}`),
          },
        );
      } catch (e) {
        log(`[fetchPushBody] threw ${(e as Error).message?.slice(0, 200)}`);
      }
    }
  };

  // ── Inject our pre-built Module into un.wasmModule + fatal reporter ─
  if (un && pn) {
    pn("wasmModule")(Module);
    pn("fatalErrorReporter")({
      reportFatalError: (e: unknown) =>
        log(`[wasm.fatal] ${JSON.stringify(e).slice(0, 200)}`),
    });
  } else {
    log(`[fidelius-decrypt] WARN un or pn missing — chunk may use its own Module`);
  }

  // ── Platform + Config + GrpcManager init ───────────────────────────
  // Mirror what the chunk's loadWasm path would do post-instantiate.
  const Platform = (Module as Record<string, unknown>).shims_Platform as Record<string, Function>;
  const ConfigReg = (Module as Record<string, unknown>).config_ConfigurationRegistry as Record<
    string,
    Function
  >;
  const GrpcManager = (Module as Record<string, unknown>).grpc_GrpcManager as Record<
    string,
    Function
  >;

  // Run tasks SYNCHRONOUSLY when the WASM submits them. The WASM uses
  // the platform task queue to dispatch the "deliver fetched messages
  // to the JS callback" work — running it sync means callbacks fire on
  // the same JS turn that asked for them, so the WASM's internal
  // expected-flow (synchronous Future → promise resolution) doesn't
  // get confused by microtask reordering. Microtask-deferral has been
  // observed to cause callback callbacks to never fire.
  const runTask = (
    task: { run?: () => void } | (() => void),
    name: string,
  ): void => {
    try {
      let result: unknown;
      if (typeof task === "function") result = (task as () => unknown)();
      else if (task && typeof task.run === "function") result = task.run();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((err) =>
          log(`[queue.${name}] async throw ${(err as Error)?.message?.slice(0, 200)}`),
        );
      }
    } catch (err) {
      log(`[queue.${name}] throw ${(err as Error)?.stack?.slice(0, 200) ?? err}`);
    }
  };
  const platformQueue = {
    submit(task: { run?: () => void } | (() => void)) {
      runTask(task, "submit");
    },
    submitWithDelay(task: { run?: () => void } | (() => void), delay: bigint | number) {
      const ms = typeof delay === "bigint" ? Number(delay) : Number(delay);
      if (ms <= 0) {
        runTask(task, "submitWithDelay");
      } else {
        setTimeout(() => runTask(task, "submitWithDelay"), Math.min(ms, 60000));
      }
    },
    enqueue(task: { run?: () => void } | (() => void)) {
      runTask(task, "enqueue");
    },
    isCurrentQueueOrTrueOnAndroid: () => true,
    flushAndStop() {},
  };

  if (Platform && typeof Platform.init === "function") {
    Platform.init(
      { assertionMode: 2, minLogLevel: 2 },
      {
        logTimedEvent: () => {},
        log: (msg: unknown) =>
          log(
            `[wasm.log] ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 200)}`,
          ),
      },
    );
    Platform.registerSerialTaskQueue?.(platformQueue);
    Platform.installErrorReporter?.({
      reportError: (e: unknown) => log(`[wasm.error] ${JSON.stringify(e).slice(0, 200)}`),
    });
    Platform.installNonFatalReporter?.({
      reportError: (e: unknown) => log(`[wasm.nonfatal] ${JSON.stringify(e).slice(0, 200)}`),
    });
  }

  if (ConfigReg) {
    const makeConfig = () => ({
      getSystemType: () => 0,
      getRealValue: (_e: unknown) => 0,
      getIntegerValue: (_e: unknown) => 0n,
      getStringValue: (_e: unknown) => "",
      getBinaryValue: (_e: unknown) => new VmU8(0),
      getBooleanValue: (_e: unknown) => false,
      getConfigurationState: () => ({}),
    });
    for (const setter of [
      "setCircumstanceEngine",
      "setCompositeConfig",
      "setExperiments",
      "setServerConfig",
      "setTweaks",
      "setUserPrefs",
    ]) {
      try {
        ConfigReg[setter]?.(makeConfig());
      } catch {
        /* setter optional in some builds */
      }
    }
  }

  // gRPC web factory — pass calls through native fetch + cookie jar.
  // Fidelius gateway calls (key lookups, etc.) flow through this.
  if (GrpcManager && typeof GrpcManager.registerWebFactory === "function") {
    GrpcManager.registerWebFactory({
      createClient: () => ({
        unaryCall: (
          path: string,
          body: Uint8Array,
          _o: unknown,
          cb: { onEvent?: Function } | undefined,
        ) => {
          const framed = new Uint8Array(5 + body.byteLength);
          new DataView(framed.buffer).setUint32(1, body.byteLength, false);
          framed.set(body, 5);
          const url = `https://web.snapchat.com${path}`;
          (async () => {
            try {
              const cookieHeader = await opts.cookieJar.getCookieString(url);
              const headers: Record<string, string> = {
                "content-type": "application/grpc-web+proto",
                "x-grpc-web": "1",
                authorization: `Bearer ${opts.bearer}`,
                "user-agent": opts.userAgent,
                "x-snap-client-user-agent":
                  "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
                "x-user-agent": "grpc-web-javascript/0.1",
              };
              if (cookieHeader) headers.cookie = cookieHeader;
              const r = await nativeFetch(url, {
                method: "POST",
                headers,
                body: framed,
              });
              const respBuf = new Uint8Array(await r.arrayBuffer());
              if (r.status !== 200) {
                cb?.onEvent?.(undefined, {
                  statusCode: 12,
                  errorString: `HTTP ${r.status}`,
                });
                return;
              }
              let p = 0;
              let dataPayload: Uint8Array | undefined;
              let trailerCode = 0;
              let trailerMsg = "";
              while (p < respBuf.byteLength) {
                if (p + 5 > respBuf.byteLength) break;
                const flag = respBuf[p]!;
                const fLen = new DataView(
                  respBuf.buffer,
                  respBuf.byteOffset + p + 1,
                  4,
                ).getUint32(0, false);
                const start = p + 5;
                const end = start + fLen;
                if (end > respBuf.byteLength) break;
                const slice = respBuf.subarray(start, end);
                if ((flag & 0x80) === 0) {
                  dataPayload = slice;
                } else {
                  const trailerStr = new TextDecoder().decode(slice);
                  const m = trailerStr.match(/grpc-status:\s*(\d+)/i);
                  if (m) trailerCode = parseInt(m[1]!);
                  const mm = trailerStr.match(/grpc-message:\s*(.+)/i);
                  if (mm) trailerMsg = mm[1]!.trim();
                }
                p = end;
              }
              if (trailerCode !== 0) {
                log(`[grpc.unary] trailer status=${trailerCode} msg=${trailerMsg}`);
                cb?.onEvent?.(undefined, {
                  statusCode: trailerCode,
                  errorString: trailerMsg,
                });
                return;
              }
              if (dataPayload) {
                const ptr = Module._malloc(dataPayload.byteLength);
                const wasmBuf = new VmU8(Module.HEAPU8.buffer, ptr, dataPayload.byteLength);
                wasmBuf.set(dataPayload);
                cb?.onEvent?.(wasmBuf, { statusCode: 0, errorString: "" });
              } else {
                cb?.onEvent?.(undefined, {
                  statusCode: 13,
                  errorString: "no data frame",
                });
              }
            } catch (e) {
              log(`[grpc.unary] error: ${(e as Error).message}`);
              cb?.onEvent?.(undefined, {
                statusCode: 13,
                errorString: (e as Error).message,
              });
            }
          })();
        },
        serverStreamingCall: (
          _p: string,
          _b: Uint8Array,
          _o: unknown,
          cb: { onEvent?: Function } | undefined,
        ) => {
          setTimeout(
            () =>
              cb?.onEvent?.(undefined, {
                statusCode: 12,
                errorString: "stream-not-implemented",
              }),
            0,
          );
        },
        bidiStreamingCall: (_p: string, _o: unknown, cb: { onEvent?: Function } | undefined) => {
          setTimeout(
            () =>
              cb?.onEvent?.(undefined, {
                statusCode: 12,
                errorString: "stream-not-implemented",
              }),
            0,
          );
        },
      }),
    });
  }

  // ── Configure En and call createMessagingSession ───────────────────
  const authGetter: () => Promise<string> = () => Promise.resolve(opts.bearer);
  En.setAuthTokenGetter(authGetter);
  En.setMcsCofSequenceIdsGetter(() => Promise.resolve([]));

  const userIdBytes = uuidToBytes16(opts.userId, VmU8);

  const clientCfg = {
    databaseLocation: ":memory:",
    userId: { id: userIdBytes },
    userAgentPrefix: "",
    debug: false,
    tweaks: { tweaks: new VmMap<number, string>() },
  };

  const sessionDelegate = {
    onConnectionStateChanged: (_s: unknown) => {},
    getAuthContextDelegate: () => ({
      getAuthContext: async (cb: { onSuccess?: Function; onError?: Function }) => {
        try {
          cb?.onSuccess?.({ authToken: opts.bearer, userId: { id: userIdBytes } });
        } catch (e) {
          cb?.onError?.(e);
        }
      },
    }),
    onDataWipe: () => {},
    onError: (e: unknown) => log(`[sessionDelegate.onError] ${JSON.stringify(e).slice(0, 200)}`),
  };

  // E2EEKeyPersistence — slot 2 of Sess.create. The bundle's own stub
  // returns `false` for persistKey/remove/requestReEncryption — meaning
  // "I don't persist keys, I don't request re-encryption". We do the
  // same for persist/remove (the WASM has its own in-memory store) but
  // RETURN TRUE for requestReEncryptionForMessage so the WASM kicks
  // off an EEL re-init handshake when it can't find a CEK for an
  // inbound message. That handshake mints a fresh CEK and the message
  // becomes decryptable on the next pass — recovering decryption for
  // messages that arrived against a previous identity (which is exactly
  // our pre-existing inbox state on first run).
  const e2eeKeyPersistence = {
    persistKeyForMessage: (_a: unknown, _b: unknown, _c: unknown) => true,
    removeKeyForMessage: (_a: unknown, _b: unknown) => true,
    // CRITICAL — returning `true` here triggers an EEL re-init handshake
    // when the WASM can't find a CEK for an inbound message. Without
    // this, pre-existing messages encrypted to a stale identity report
    // CEK_ENTRY_NOT_FOUND and the messagingDelegate sees empty content.
    requestReEncryptionForMessage: (_a: unknown, _b: unknown, _c: unknown) => true,
    storeUserWrappedIdentityKeys: (_e: unknown) => {},
    loadUserWrappedIdentityKeys: async () => [],
  };

  const mediaUploadDelegate = {
    uploadMedia: (_e: unknown, _t: unknown, _r: unknown) => {},
    uploadMediaReferences: (_e: unknown, _t: unknown) => {},
  };

  const snapchatterInfoDelegate = {
    fetchSnapchatterInfos: async (_e: unknown) =>
      Promise.reject(new Error("Not implemented")),
    fetchFriendLink: (_t: unknown, _r: unknown) => {},
  };

  // Slot 6 (analyticsLogger) — the bundle calls this on every WASM-side
  // event (RECEIVE_MESSAGE, decrypt_failure, …). We swallow them; throwing
  // here propagates back into the messaging path and is caught by our
  // try/catch around the wrapped delegate, but the spam isn't useful.
  const analyticsLogger = (_ev: unknown): void => {};

  // pr()-compatible storage adapters. Backed by `opts.dataStore` when
  // provided so the WASM's persisted identity keys survive script
  // restarts — without persistence, the WASM mints a fresh Fidelius
  // identity each run and any messages encrypted to our PREVIOUS
  // public key fail to decrypt with `CEK_ENTRY_NOT_FOUND`.
  // Canonical UDS slot path uses `local_` prefix (composed with slot
  // names like `uds.e2eeIdentityKey.shared` → `local_uds.e2eeIdentityKey.shared`).
  // An earlier version used `local_uds_` which produced the duplicate
  // `local_uds_uds.e2eeIdentityKey.shared` key alongside the canonical one.
  const UDS_PREFIX = "local_";
  const td = new TextDecoder();
  const te = new TextEncoder();
  const ds = opts.dataStore;
  const inMemFallback = new Map<string, Map<string, string>>();
  const inMemUds = (label: string) => {
    void label;
    if (!inMemFallback.has(label)) inMemFallback.set(label, new Map());
    const memStore = inMemFallback.get(label)!;
    return {
      async getItem(k: string) {
        if (ds) {
          try {
            const bytes = await ds.get(UDS_PREFIX + k);
            return bytes ? td.decode(bytes) : undefined;
          } catch { /* fall through to mem */ }
        }
        return memStore.get(k);
      },
      async setItem(k: string, v: string) {
        const s = typeof v === "string" ? v : String(v);
        memStore.set(k, s);
        if (ds) {
          try { await ds.set(UDS_PREFIX + k, te.encode(s)); }
          catch { /* tolerate */ }
        }
      },
      async removeItem(k: string) {
        memStore.delete(k);
        if (ds) {
          try { await ds.delete(UDS_PREFIX + k); }
          catch { /* tolerate */ }
        }
      },
      async keys() {
        if (ds && typeof ds.keys === "function") {
          const all = ds.keys(UDS_PREFIX) ?? [];
          return all.map((k) => k.slice(UDS_PREFIX.length));
        }
        return Array.from(memStore.keys());
      },
    };
  };

  // Slot 10 (`l`) is the **friend keys cache fallback** — the WASM's
  // `getKeysForUserAsync` calls `o(userId)` (where `o` is inner async
  // arg #5 = outer slot 10) when its in-WASM cache misses. It expects a
  // Promise resolving to the friend's wrapped public keys, OR a falsy
  // value to trigger the syncFriendKeys gRPC fallback. We return
  // undefined — the WASM then calls syncFriendKeys via the GrpcManager
  // factory, which fetches from the Fidelius gateway and caches the
  // result. Without this being a function, fresh inbound messages from
  // any sender whose keys aren't already cached fail to decrypt with
  // `o is not a function` and the WS push pipeline goes silent.
  const friendKeysCacheLookup = async (_userId: unknown): Promise<undefined> =>
    undefined;
  // Slot 15 (`g`) becomes inner async arg #8 (`c`) which is used in
  // `ht(e) === ht(c) ? "current" : "friend"` — the current user identity
  // for differentiating self vs friend in metric dimensions.
  const currentUserIdentity = { id: userIdBytes };
  const sessionArgs = [
    /* 0 e */ clientCfg,
    /* 1 t */ sessionDelegate,
    /* 2 r */ e2eeKeyPersistence,
    /* 3 n */ mediaUploadDelegate,
    /* 4 s */ {},
    /* 5 a */ snapchatterInfoDelegate,
    /* 6 i */ analyticsLogger,
    /* 7 c */ (() => {
      // rwk storage: { get, set, purge }. Persist through DataStore so
      // the Fidelius rwk (root wrapping key) survives across runs and
      // pre-existing CEKs remain unwrappable.
      const RWK_KEY = "local_rwk_blob";
      return {
        async get() {
          if (ds) {
            const bytes = await ds.get(RWK_KEY);
            if (bytes) {
              const s = td.decode(bytes);
              try { return JSON.parse(s); }
              catch { return s; }
            }
          }
          return undefined;
        },
        async set(v: unknown) {
          if (ds) {
            try {
              const s = typeof v === "string" ? v : JSON.stringify(v, bigintReplacer);
              await ds.set(RWK_KEY, te.encode(s));
            } catch (e) {
              log(`[rwk.set] err ${(e as Error).message?.slice(0, 100)}`);
            }
          }
        },
        async purge() {
          // Intentionally a no-op (logged): the WASM calls purge() as a
          // best-effort hint to rotate the wrapping key, but our SDK
          // persists across runs — losing the RWK forces a re-mint and
          // resets the entire identity (every cached CEK becomes
          // unwrappable). We tolerate the rotation hint by ignoring it;
          // the WASM regenerates the in-memory RWK on next session boot
          // from the persisted blob.
          log("[rwk.purge.skipped]");
        },
      };
    })(),
    /* 8 u */ inMemUds("e2eeIdentityKey"),
    /* 9 m */ inMemUds("e2eeTempKey"),
    /* 10 l */ friendKeysCacheLookup,
    /* 11 d */ async () => {
      // loadUserWrappedIdentityKeys — returns the cached identity key
      // list. The bundle's `pr()` storage (slots 8 + 9) tracks these
      // under `uds.e2eeIdentityKey.shared` (a JSON-encoded array). Read
      // it back here so the bundle skips the InitializeWebKey re-mint
      // path on startup.
      if (!ds) return [];
      try {
        const bytes = await ds.get(UDS_PREFIX + "uds.e2eeIdentityKey.shared");
        if (!bytes) return [];
        const arr = JSON.parse(td.decode(bytes));
        return Array.isArray(arr) ? arr : [];
      } catch (e) {
        log(`[loadUserWrappedIdentityKeys] err ${(e as Error).message?.slice(0, 100)}`);
        return [];
      }
    },
    /* 12 _ */ {},
    /* 13 f */ {},
    /* 14 p */ { id: userIdBytes },
    /* 15 g */ currentUserIdentity,
    /* 16 y */ {},
    /* 17 h */ {},
  ];

  let session: Record<string, Function>;
  try {
    const sessionPromise = En.createMessagingSession(...sessionArgs);
    session = await Promise.race([
      sessionPromise,
      new Promise<never>((_r, rej) =>
        setTimeout(() => rej(new Error("createMessagingSession timeout (15s)")), 15000),
      ),
    ]);
  } catch (e) {
    log(`[fidelius-decrypt] createMessagingSession FAILED: ${(e as Error).message}`);
    throw e;
  }

  // Capture the session ref for the live-push body fetch path
  // (handlePushMessage → fetchPushBody → cm.fetchMessage).
  capturedSession = session;

  // Hand the session out to the caller — `Messaging.sendText/sendImage/sendSnap`
  // hold the reference and drive `sendMessageWithContent` through it.
  if (opts.onSession) {
    try { opts.onSession(session); }
    catch (e) {
      log(`[fidelius-decrypt] onSession callback threw ${(e as Error).message?.slice(0, 200)}`);
    }
  }

  // ── CRITICAL: pulse reachabilityChanged + appStateChanged(ACTIVE) ──
  // Per bundle source (byte 63300): immediately after `messaging_Session.create`
  // returns, the chunk does:
  //   b.reachabilityChanged(true);
  //   b.appStateChanged(o.tq.ACTIVE);  // ACTIVE = 0
  // These transitions wake the messaging session into the ACTIVE state.
  // Without them the session stays in INACTIVE mode where the WASM
  // routes message-decrypt results to the analytics path only and
  // suppresses delivery via the messagingDelegate. Symptom: RECEIVE_MESSAGE
  // analytics events fire for new messages but onMessageReceived/
  // onMessagesReceived hooks stay silent.
  //
  // o.tq enum values (best guess; bundle uses ACTIVE=0, BACKGROUND=1):
  //   ACTIVE = 0, BACKGROUND = 1, INACTIVE = 2
  const sessAny = session as Record<string, Function>;
  if (typeof sessAny.reachabilityChanged === "function") {
    try { sessAny.reachabilityChanged(true); }
    catch (e) {
      log(`[fidelius-decrypt] reachabilityChanged threw ${(e as Error).message?.slice(0, 200)}`);
    }
  }
  if (typeof sessAny.appStateChanged === "function") {
    // Try ACTIVE=0 first; if Embind enum binding rejects, fall through.
    for (const v of [0, 1, 2]) {
      try { sessAny.appStateChanged(v); break; }
      catch { /* try next */ }
    }
  }

  // ── Wake up live push: register sync_trigger handler + nudge ───────
  // The bundle's React layer normally registers a "sync_trigger" duplex
  // handler that, on each pushed payload, calls back into the WASM's
  // sync routines (which then surface new messages via the messaging
  // delegate). Without this, the WS receives push frames for that path
  // and the duplex client drops them with reason="no_handler", so live
  // inbound stays silent until polling-triggered DeltaSync stumbles
  // across them. We register a no-op handler — the sole purpose is to
  // STOP the drop and let the duplex client's framing pass through.
  // The actual sync side-effect (a follow-up DeltaSync) happens in the
  // WASM independently.
  if (typeof En.registerDuplexHandler === "function") {
    try {
      En.registerDuplexHandler("sync_trigger", { onReceive: (_bytes: Uint8Array) => {} });
    } catch (e) {
      log(
        `[fidelius-decrypt] registerDuplexHandler("sync_trigger") threw: ${(e as Error).message?.slice(0, 200)}`,
      );
    }
  }

  // Pulse `onNetworkStatusChange("BROWSER_ONLINE")` — Snap's `sr` class
  // is NOT a BehaviorSubject; subscribers only fire on `.next()`, never
  // on the initial value. The duplex client subscribes during fn()'s
  // first invocation but at that point the observable's current value
  // (BROWSER_ONLINE) is silent. A `.next()` call after subscription
  // re-runs the duplex client's online branch, which can re-arm the
  // WS read loop on builds where init() didn't auto-open it.
  if (typeof En.onNetworkStatusChange === "function") {
    try { En.onNetworkStatusChange("BROWSER_ONLINE"); }
    catch (e) {
      log(
        `[fidelius-decrypt] onNetworkStatusChange threw: ${(e as Error).message?.slice(0, 200)}`,
      );
    }
  }

  // ── Pump the inbox: enter conversations + fetch history ────────────
  //
  // Strategy:
  //   - DeltaSync runs continuously after createMessagingSession via the
  //     bundle's own duplex client; it pulls new content into the WASM's
  //     internal cache.
  //   - enterConversation marks a conv "active" and biases live delivery
  //     toward that conv. Enter the TARGET (priority) conv LAST so it
  //     stays active during the wait window.
  //   - fetchConversationWithMessages reads the WASM's current conv
  //     state and surfaces history through the messagingDelegate hook.
  const convIds = opts.conversationIds ?? [];
  const targetConvId = convIds[0]; // caller convention: priority conv first

  if (convIds.length > 0) {
    try {
      const cm = (session.getConversationManager as Function)?.() as
        | Record<string, Function>
        | undefined;

      if (cm) {
        if (process.env.SNAPCAP_PROBE_CONVMGR) {
          // One-shot introspection — print every method on convMgr and a
          // .toString() of the candidates we suspect.
          const allKeys: string[] = [];
          let proto: object | null = cm as unknown as object;
          while (proto && proto !== Object.prototype) {
            for (const k of Object.getOwnPropertyNames(proto)) {
              if (typeof (cm as Record<string, unknown>)[k] === "function") allKeys.push(k);
            }
            proto = Object.getPrototypeOf(proto);
          }
          log(`[probe] convMgr keys: ${Array.from(new Set(allKeys)).sort().join(", ")}`);
          for (const k of ["fetchMessage", "fetchMessageByServerId", "fetchMessagesByServerIds", "fetchServerMessageIdentifier", "fetchMessageForQuotedView", "fetchMessages"]) {
            const fn = (cm as Record<string, unknown>)[k];
            if (typeof fn === "function") {
              log(`[probe] cm.${k}.toString = ${(fn as Function).toString().slice(0, 200)}`);
              log(`[probe] cm.${k}.length = ${(fn as Function).length}`);
            }
          }
        }
        // History-fetch every conv first — surfaces decrypted messages
        // through the wrapped messagingDelegate.onMessagesReceived hook.
        for (const convId of convIds) {
          const idBytes = uuidToBytes16(convId, VmU8);
          if (typeof cm.fetchConversationWithMessages === "function") {
            try {
              cm.fetchConversationWithMessages(
                { id: idBytes },
                {
                  onFetchConversationWithMessagesComplete: (
                    _conv: unknown,
                    messages: unknown,
                    _hasMore: unknown,
                  ) => {
                    if (Array.isArray(messages)) {
                      for (const m of messages) deliverPlaintext(m, opts.onPlaintext, log);
                    }
                  },
                  onError: (...a: unknown[]) =>
                    log(`[fetchConvMsgs.${convId}] onError ${safeStringifyVal(a).slice(0, 200)}`),
                },
              );
            } catch (e) {
              log(`[fetchConvMsgs.${convId}] threw ${(e as Error).message?.slice(0, 200)}`);
            }
          }
        }

        // Enter NON-target convs first; target LAST so it stays active.
        if (typeof cm.enterConversation === "function") {
          const enterOrder: string[] = [];
          for (const c of convIds) if (c !== targetConvId) enterOrder.push(c);
          if (targetConvId) enterOrder.push(targetConvId);
          for (const convId of enterOrder) {
            const idBytes = uuidToBytes16(convId, VmU8);
            try {
              cm.enterConversation({ id: idBytes }, 0, {
                onSuccess: () => {},
                onError: (...a: unknown[]) =>
                  log(`[enterConversation] onError ${safeStringifyVal(a).slice(0, 200)}`),
              });
            } catch (e) {
              log(`[enterConversation] threw ${(e as Error).message?.slice(0, 200)}`);
            }
          }
        }
      }
    } catch (e) {
      log(`[fidelius-decrypt] manager probe err: ${(e as Error).message}`);
    }
  }

  return () => {
    /* no-op disposer for now */
  };
}

/**
 * JSON.stringify replacer that survives BigInt — Embind hands us i64/u64
 * fields as BigInt and the bundle's analytics paths choke on them. We
 * coerce to string for log purposes only.
 */
function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() + "n" : v;
}

/**
 * Extract `t.content` (the WASM's plaintext bytes) from a messaging
 * delegate callback's argument and forward to the consumer's
 * `onPlaintext`. Cross-realm safe: identifies `Uint8Array` by
 * `constructor.name` instead of `instanceof`.
 */
function deliverPlaintext(
  m: unknown,
  onPlaintext: (msg: PlaintextMessage) => void,
  log: (line: string) => void,
): void {
  if (!m || typeof m !== "object") return;
  const obj = m as Record<string, unknown>;
  const content = obj.content;
  const isSender = obj.isSender as boolean | undefined;
  const contentType = obj.contentType as number | undefined;
  if (!content) {
    // Compact diagnostic: helps catch decrypt regressions (CEK_ENTRY_NOT_FOUND
    // would mean every inbound message lands here with empty content).
    const dfr = obj.decryptFailureReason;
    log(
      `PLAIN.skip: ct=${contentType} isSender=${isSender} decryptFailureReason=${safeStringifyVal(dfr)}`,
    );
    return;
  }

  // Cross-realm Uint8Array detection. Embind hands us one of:
  //   - sandbox-realm Uint8Array (constructor.name === "Uint8Array")
  //   - host-realm Uint8Array (instanceof passes)
  //   - host-realm number[] (rare with Embind <vector<uint8_t>>)
  let bytes: Uint8Array | undefined;
  if (content instanceof Uint8Array) {
    bytes = content;
  } else if (
    content &&
    typeof content === "object" &&
    (content as { constructor?: { name?: string } }).constructor?.name === "Uint8Array"
  ) {
    const c = content as { byteLength: number; [k: number]: number };
    bytes = new Uint8Array(c.byteLength);
    for (let i = 0; i < c.byteLength; i++) bytes[i] = c[i] ?? 0;
  } else if (Array.isArray(content)) {
    bytes = new Uint8Array(content as number[]);
  }

  if (!bytes || bytes.byteLength === 0) return;

  // Surface a hyphenated conversationId on `raw` so consumers can filter
  // without re-decoding the embedded ID-bytes object. The WASM hands us
  // either a top-level `conversationId: { id: Uint8Array(16) }` (live
  // push) or only `conversationMetricsData.conversationId: { id: ... }`
  // (some history paths). Normalize both into `raw.conversationId` as
  // a UUID string while leaving the original obj keys intact for callers
  // that want the raw shape.
  const ridTop = (obj.conversationId as { id?: unknown } | undefined)?.id;
  const md = obj.conversationMetricsData as { conversationId?: unknown } | undefined;
  const ridMd = (md?.conversationId as { id?: unknown } | undefined)?.id;
  const ridBytes = ridTop ?? ridMd;
  let convIdStr: string | undefined;
  if (ridBytes) {
    convIdStr = bytesToUuidString(ridBytes);
  }
  const rawOut: Record<string, unknown> = { ...obj };
  if (convIdStr && !rawOut.conversationId) {
    rawOut.conversationId = convIdStr;
  } else if (convIdStr && rawOut.conversationId && typeof rawOut.conversationId === "object") {
    // Bundle hands us `{ id: bytes }`; promote a sibling string field for
    // simple filtering. Keep the original object under `conversationIdRaw`.
    rawOut.conversationIdRaw = rawOut.conversationId;
    rawOut.conversationId = convIdStr;
  }

  if (process.env.SNAPCAP_DEBUG_WORKER) {
    log(`[deliver] bytes=${bytes.byteLength} convId=${convIdStr ?? "?"} ct=${contentType} isSender=${isSender}`);
  }

  onPlaintext({ content: bytes, isSender, contentType, raw: rawOut });
}

/**
 * Convert a 16-byte UUID byte array (from Embind) back into a
 * hyphenated UUID string. Cross-realm safe.
 */
function bytesToUuidString(b: unknown): string | undefined {
  if (!b) return undefined;
  // Walk to a 16-byte indexable — handles real Uint8Array, cross-realm
  // typed array, plain {0,1,...,15,byteLength:16}, or an array.
  const o = b as { byteLength?: number; length?: number; [k: number]: number };
  const n = o.byteLength ?? o.length ?? 0;
  if (n !== 16) return undefined;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    const v = (o[i] ?? 0) & 0xff;
    hex.push(v.toString(16).padStart(2, "0"));
  }
  const h = hex.join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/** Convert UUID string ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") to 16 bytes in the given realm's Uint8Array. */
function uuidToBytes16(uuid: string, VmU8: Uint8ArrayConstructor): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`uuidToBytes16: expected 32 hex chars, got ${hex.length} for "${uuid}"`);
  }
  const out = new VmU8(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Loose UUID → 16-byte realm-Uint8Array. Returns `undefined` if the
 * string isn't UUID-shaped (Snap sometimes emits ids that miss
 * separators or vary in case).
 */
function uuidStringToBytes16(uuid: string, VmU8: Uint8ArrayConstructor): Uint8Array {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    // Best-effort — pad / truncate to 16 bytes worth of hex.
    const padded = (hex + "00000000000000000000000000000000").slice(0, 32);
    const out = new VmU8(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  }
  const out = new VmU8(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Coerce one of the bundle's Embind ID shapes to a realm-local 16-byte
 * Uint8Array. Embind hands us either:
 *   - `{ id: Uint8Array(16) }` (most common — e.g. conversationId on
 *     conversationMetricsData)
 *   - `{ id: { 0:n, 1:n, …, 15:n, byteLength:16 } }` (cross-realm shape
 *     where the inner Uint8Array's prototype isn't ours)
 *   - a bare 16-byte Uint8Array
 *   - a UUID string (rare but possible)
 *
 * Returns `undefined` if none of the above produce 16 bytes.
 */
function coerceIdBytes(v: unknown, VmU8: Uint8ArrayConstructor): Uint8Array | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    return uuidStringToBytes16(v, VmU8);
  }
  // Walk one or two levels to find a 16-byte buffer.
  const tryRead = (b: unknown): Uint8Array | undefined => {
    if (!b) return undefined;
    if (b instanceof Uint8Array && b.byteLength === 16) {
      const out = new VmU8(16);
      out.set(b);
      return out;
    }
    if (typeof b === "object") {
      const o = b as { byteLength?: number; [k: number]: number };
      if (o.byteLength === 16) {
        const out = new VmU8(16);
        for (let i = 0; i < 16; i++) out[i] = o[i] ?? 0;
        return out;
      }
    }
    return undefined;
  };
  const direct = tryRead(v);
  if (direct) return direct;
  const inner = (v as { id?: unknown }).id;
  return tryRead(inner);
}

/** Cross-realm-safe value stringifier that survives BigInt + circular refs. */
function safeStringifyVal(v: unknown): string {
  if (v === undefined) return "undef";
  if (v === null) return "null";
  if (typeof v === "bigint") return v.toString() + "n";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return String(v);
  try {
    return JSON.stringify(v, (_k, vv) => (typeof vv === "bigint" ? vv.toString() + "n" : vv));
  } catch {
    return "[unserial]";
  }
}

/** Re-export the realm helper so callers can boot without a separate import. */
export { getStandaloneChatRealm } from "./fidelius-mint.ts";
export type { StandaloneChatRealm, StandaloneChatModule } from "./fidelius-mint.ts";
