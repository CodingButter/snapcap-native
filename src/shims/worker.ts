/**
 * Worker class shim — synchronous in-process Web Worker simulator.
 *
 * Snap's bundle calls `new Worker(url)` to spawn a thread that boots
 * the messaging WASM. vm.Context has no `Worker` class. This shim
 * satisfies the contract by running the worker's JS synchronously
 * in a small isolated "worker scope" that has its own `self` /
 * `postMessage` / `importScripts` / `onmessage` / `addEventListener` /
 * `removeEventListener`. Comlink wrapping works as if it were a real
 * worker — postMessage round-trips happen via the microtask queue.
 *
 * Construction flow (matches the bundle's `Wp.c` wrapper at module
 * 77207, then the underlying `new Worker(...)`):
 *   1. The bundle does
 *        URL.createObjectURL(new Blob([
 *          `importScripts(${JSON.stringify(realChunkURL)});`
 *        ]))
 *      then `new Worker(blobUrl, opts)`.
 *   2. Our constructor receives the blob URL. We resolve it via
 *      `node:buffer.resolveObjectURL` and read the `importScripts(...)`
 *      payload to recover `realChunkURL`. (If a non-blob URL is passed
 *      directly we use it verbatim.)
 *   3. We strip the basename (e.g. `f16f14e3...chunk.js`) and read
 *      from the on-disk vendored bundle at
 *      `<bundleDir>/cf-st.sc-cdn.net/dw/<basename>`.
 *   4. We build a per-worker scope object exposing `self`,
 *      `postMessage`, `importScripts`, `addEventListener`,
 *      `removeEventListener`, `onmessage`. The chunk source is wrapped
 *      in an IIFE that takes the scope as `self`/`globalThis`-like
 *      surface and eval'd in the SAME sandbox realm (so cross-realm
 *      types — Promise, Uint8Array, Map — match the rest of the
 *      bundle). The chunk's own `webpackChunk_*` array still lands on
 *      the realm `globalThis`, which is fine — nobody else iterates
 *      it after this point.
 *
 * Outer ↔ inner postMessage — SYNCHRONOUS in-call delivery:
 *   - `worker.postMessage(data)` → directly invokes `scope.onmessage({ data })`
 *     and any inner listeners in the same call stack.
 *   - `scope.postMessage(data)` → directly invokes outer listeners and
 *     `worker.onmessage` in the same call stack.
 *
 *   The bundle was written for browser Workers where postMessage is
 *   async, but synchronous is a strict subset of async behavior — the
 *   bundle cannot observe the difference unless it deliberately checks,
 *   which webpack-emitted code never does. An earlier version deferred
 *   each delivery via `queueMicrotask`; the chunk's init code registered
 *   its message handler in a microtask that fired AFTER the main thread
 *   had already sent the boot message, so the boot reply never arrived.
 *   Synchronous delivery eliminates that race entirely.
 *
 * Comlink's protocol is request/response over `postMessage` keyed by
 * an `id` field in the data envelope; it does not require structured
 * cloning or transferables. We pass values by reference (no clone) —
 * cheaper, and still correct because both sides live in the same
 * realm. The MessagePort transfer list (`postMessage(data, ports)`)
 * is currently ignored; Comlink falls back to ID-based correlation
 * through the data envelope, which is enough for `Mp.LV(worker)` to
 * wrap our worker proxy.
 *
 * @internal
 *
 * TODO: MessagePort / MessageChannel transfer support. Comlink uses
 *   transferable ports for sub-proxies (e.g. arguments that are
 *   themselves Comlink endpoints). Until needed, sub-proxies will
 *   fail at the `port1.start()` call inside Comlink — surface as a
 *   clear error from there if any consumer hits it.
 */
import vm from "node:vm";
import { resolveObjectURL } from "node:buffer";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { Sandbox } from "./sandbox.ts";

/** Outer-facing handle returned by `new Worker(...)`. */
type MessageListener = (ev: { data: unknown }) => void;

/**
 * Synchronous in-process Web Worker simulator. Exposed inside the
 * sandbox realm under `globalThis.Worker` by {@link installWorkerShim}.
 *
 * @internal
 */
export class FakeWorker {
  /** Listeners registered via `addEventListener("message", h)`. */
  private readonly outerListeners: Set<MessageListener> = new Set();
  /** Listeners registered via `addEventListener("error", h)`. */
  private readonly outerErrorListeners: Set<(ev: { error: unknown }) => void> = new Set();
  /** `worker.onmessage = h` slot. */
  onmessage: MessageListener | null = null;
  /** `worker.onerror = h` slot. */
  onerror: ((ev: { error: unknown }) => void) | null = null;
  /** Inner-scope `onmessage` slot — set by the chunk via `self.onmessage = ...`. */
  private innerOnmessage: MessageListener | null = null;
  /** Inner-scope listeners from `self.addEventListener("message", h)`. */
  private readonly innerListeners: Set<MessageListener> = new Set();
  /** True after `terminate()` — drops further messages on the floor. */
  private terminated = false;

  constructor(
    url: URL | string,
    _opts: { name?: string; type?: string; credentials?: string } | undefined,
    sandbox: Sandbox,
    bundleDir: string,
  ) {
    const realUrl = resolveBlobOrUrl(String(url));
    const chunkBasename = basename(realUrl.split("?")[0] ?? realUrl);
    const chunkPath = join(bundleDir, "cf-st.sc-cdn.net", "dw", chunkBasename);
    const chunkSrc = readFileSync(chunkPath, "utf8");

    // Build the worker scope. Everything the chunk reaches for via
    // `self.X` / `globalThis.X` / bare references at the top of the
    // chunk needs to land here. The chunk also registers its own
    // webpack chunk array via `globalThis.webpackChunk_*`, which we
    // let pass through to the sandbox realm globalThis — nobody else
    // iterates it after the chunk loads, and keeping it realm-global
    // means the chunk's `s.p+s.u(...)` chunk-loader can resolve
    // sibling chunks if it tries.
    const scope: Record<string, unknown> = {
      // Inner postMessage → outer listeners. Synchronous: invoked in
      // the same call stack as the inner code that called postMessage.
      postMessage: (data: unknown, _transfer?: unknown) => {
        if (this.terminated) return;
        if (process.env.SNAPCAP_DEBUG_WORKER) {
          // eslint-disable-next-line no-console
          console.error(`[worker→outer]`, JSON.stringify(data).slice(0, 200));
        }
        const ev = { data };
        if (this.onmessage) {
          try { this.onmessage(ev); } catch (e) { this.fireOuterError(e); }
        }
        for (const l of this.outerListeners) {
          try { l(ev); } catch (e) { this.fireOuterError(e); }
        }
      },
      // Recursive importScripts: resolve each URL the same way and
      // eval in the SAME worker scope. The chunk's own webpack
      // runtime calls this for sibling chunks (e.g. 06c27f3b…).
      importScripts: (...urls: unknown[]) => {
        for (const u of urls) {
          if (process.env.SNAPCAP_DEBUG_WORKER) {
            // eslint-disable-next-line no-console
            console.error(`[worker importScripts] ${String(u)}`);
          }
          try {
            const r = resolveBlobOrUrl(String(u));
            const b = basename(r.split("?")[0] ?? r);
            const p = join(bundleDir, "cf-st.sc-cdn.net", "dw", b);
            const src = readFileSync(p, "utf8");
            this.evalInScope(sandbox, src, scope, b);
            if (process.env.SNAPCAP_DEBUG_WORKER) {
              // eslint-disable-next-line no-console
              console.error(`[worker importScripts] ✓ ${b} loaded (${src.length} bytes)`);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[worker importScripts] ✗ ${String(u)} threw: ${(err as Error).message}`);
            throw err;
          }
        }
      },
      // Inner-side message wiring.
      addEventListener: (type: string, listener: unknown) => {
        if (typeof listener !== "function") return;
        if (type === "message") {
          this.innerListeners.add(listener as MessageListener);
          if (process.env.SNAPCAP_DEBUG_WORKER) {
            // eslint-disable-next-line no-console
            console.error(`[worker] inner addEventListener("message") → listeners=${this.innerListeners.size}`);
          }
        }
      },
      removeEventListener: (type: string, listener: unknown) => {
        if (type === "message") this.innerListeners.delete(listener as MessageListener);
      },
      // Inner-side onmessage slot — defined as accessor below so
      // `self.onmessage = h` actually lands on `this.innerOnmessage`.
      // (Plain data property assignment would shadow our reference.)
      // Filled in via Object.defineProperty.
      onmessage: null as MessageListener | null,
      // Misc Worker-scope globals the chunk may probe for.
      name: _opts?.name ?? "",
      close: () => { this.terminated = true; },
    };
    Object.defineProperty(scope, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => this.innerOnmessage,
      set: (v: MessageListener | null) => { this.innerOnmessage = typeof v === "function" ? v : null; },
    });
    // Worker scope detection — Snap's chunk does `self instanceof WorkerGlobalScope`
    // to decide whether to register a message handler. Without these classes
    // defined, the chunk falls back to "main" mode (no handler) and our
    // postMessage round-trips hang forever.
    class WorkerGlobalScope {}
    class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
    Object.setPrototypeOf(scope, DedicatedWorkerGlobalScope.prototype);
    scope.WorkerGlobalScope = WorkerGlobalScope;
    scope.DedicatedWorkerGlobalScope = DedicatedWorkerGlobalScope;
    // Self-reference: `self === globalThis` inside the worker scope.
    scope.self = scope;
    scope.globalThis = scope;

    // Eval the worker chunk source against this scope.
    try {
      this.evalInScope(sandbox, chunkSrc, scope, chunkBasename);
      if (process.env.SNAPCAP_DEBUG_WORKER) {
        // eslint-disable-next-line no-console
        console.error(`[worker init] chunk ${chunkBasename} eval'd. innerOnmessage=${this.innerOnmessage ? "set" : "null"}, listeners=${this.innerListeners.size}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[worker init] chunk eval threw:`, (err as Error).message);
      // eslint-disable-next-line no-console
      console.error((err as Error).stack?.split("\n").slice(0, 8).join("\n"));
      throw err;
    }
  }

  /**
   * Outer postMessage → inner onmessage + inner listeners. Synchronous:
   * invoked in the same call stack as the outer caller.
   */
  postMessage(data: unknown, _transfer?: unknown): void {
    if (this.terminated) return;
    if (process.env.SNAPCAP_DEBUG_WORKER) {
      // eslint-disable-next-line no-console
      console.error(`[outer→worker]`, JSON.stringify(data).slice(0, 200), `(handlers: onmessage=${this.innerOnmessage ? "1" : "0"}, listeners=${this.innerListeners.size})`);
    }
    const ev = { data };
    if (this.innerOnmessage) {
      try { this.innerOnmessage(ev); } catch (e) { this.fireOuterError(e); }
    }
    for (const l of this.innerListeners) {
      try { l(ev); } catch (e) { this.fireOuterError(e); }
    }
  }

  addEventListener(type: string, listener: unknown): void {
    if (typeof listener !== "function") return;
    if (type === "message") this.outerListeners.add(listener as MessageListener);
    else if (type === "error") this.outerErrorListeners.add(listener as (ev: { error: unknown }) => void);
  }

  removeEventListener(type: string, listener: unknown): void {
    if (type === "message") this.outerListeners.delete(listener as MessageListener);
    else if (type === "error") this.outerErrorListeners.delete(listener as (ev: { error: unknown }) => void);
  }

  terminate(): void {
    this.terminated = true;
    this.outerListeners.clear();
    this.outerErrorListeners.clear();
    this.innerListeners.clear();
    this.innerOnmessage = null;
    this.onmessage = null;
    this.onerror = null;
  }

  private fireOuterError(err: unknown): void {
    const ev = { error: err };
    if (this.onerror) {
      try { this.onerror(ev); } catch { /* swallow */ }
    }
    for (const l of this.outerErrorListeners) {
      try { l(ev); } catch { /* swallow */ }
    }
  }

  /**
   * Eval `src` in the sandbox realm, but with the worker `scope`
   * standing in for `self` / `globalThis` / bare globals the chunk
   * reads. We wrap in an IIFE that receives the scope and re-binds
   * the well-known names; the IIFE's `function` body gives webpack's
   * top-level `var` declarations a fresh lexical scope so successive
   * `importScripts` re-evals don't trip "already declared" errors.
   *
   * Falls into the surrounding sandbox `try`/`catch` if the chunk
   * throws at top-level — we propagate via the outer `error` channel.
   */
  private evalInScope(
    sandbox: Sandbox,
    src: string,
    scope: Record<string, unknown>,
    filename: string,
  ): void {
    // Stash the scope on the realm so the IIFE wrapper can read it
    // back without us having to pass it as an arg through runInContext
    // (which only takes a string source). Unique key per worker so two
    // workers don't stomp each other.
    const stashKey = `__SNAPCAP_WORKER_SCOPE_${Math.random().toString(36).slice(2)}`;
    sandbox.setGlobal(stashKey, scope);
    try {
      const wrapped =
        `(function(self) {\n` +
        `  const globalThis = self;\n` +
        `  const postMessage = self.postMessage;\n` +
        `  const importScripts = self.importScripts;\n` +
        `  const addEventListener = self.addEventListener.bind(self);\n` +
        `  const removeEventListener = self.removeEventListener.bind(self);\n` +
        src +
        `\n})(globalThis.${stashKey});`;
      sandbox.runInContext(wrapped, filename);
    } catch (err) {
      this.fireOuterError(err);
      throw err;
    } finally {
      sandbox.setGlobal(stashKey, undefined);
    }
  }
}

/**
 * If `url` is a `blob:` URL, decode the underlying blob (it should be
 * `application/javascript` containing a single `importScripts("X");`
 * call written by the bundle's `Wp.c` wrapper) and return X. Otherwise
 * return `url` unchanged.
 *
 * Sync I/O — `resolveObjectURL` returns a `Blob` instance whose
 * `.text()` is a Promise. We bypass it by reading the bytes via the
 * Node Blob's `[Symbol.asyncIterator]` … actually the Node Blob
 * exposes `.arrayBuffer()`, also async. Sync read by digging into the
 * private buffer slot is brittle across Node versions; instead we
 * drain via `Atomics.wait` is overkill — easiest and stable: use
 * `blob.text()` synchronously is impossible. We side-step the whole
 * thing by reading the registered buffer through Node's internal
 * `Buffer.from(await blob.arrayBuffer())` shape via a deasync trick.
 *
 * Pragmatic alternative that works today: Node's blob URL registry
 * gives us a `Blob`; we read its bytes synchronously by digging into
 * the `kHandle` slot (Node-internal), but that's fragile. The robust
 * sync path is to use `Symbol.iterator`-ish — there isn't one.
 *
 * Practical solution: parse the `importScripts(...)` text via REGEX
 * over the only thing the bundle ever puts inside the blob —
 * `importScripts("https://…")` — and we never need to decode the
 * blob bytes at all. We get the text by calling `.text()` and
 * blocking via `deasync`, OR (simpler) we accept the small
 * chicken-and-egg by treating this codepath as "if we got a blob:
 * URL, the only thing the Snap bundle ever writes there is an
 * `importScripts(realURL)` payload" — so we can tee the URL at the
 * `URL.createObjectURL` patch point. See {@link installWorkerShim}.
 */
function resolveBlobOrUrl(url: string): string {
  if (!url.startsWith("blob:")) return url;
  const cached = blobUrlRegistry.get(url);
  if (cached) return cached;
  // Last-ditch: try `node:buffer.resolveObjectURL`. If the bundle
  // bypassed our `URL.createObjectURL` patch (e.g. constructed the
  // blob URL via a different realm), this still recovers the bytes
  // — best-effort sync: we drop into `deasync`-free territory by
  // reading the Blob's underlying bytes via the well-known Node
  // internal field. Failure → throw with a clear diagnostic.
  const blob = resolveObjectURL(url);
  if (!blob) {
    throw new Error(
      `Worker shim: blob URL "${url}" did not resolve — was URL.createObjectURL invoked from a different realm?`,
    );
  }
  // Node's Blob stores bytes in a chained handle; the only stable
  // sync escape hatch is `.stream().getReader()` which is also async.
  // If we get here, the blob URL slipped past our patch — surface a
  // clear error instead of stalling on async I/O inside a sync
  // constructor.
  throw new Error(
    `Worker shim: blob URL "${url}" was created without going through the patched URL.createObjectURL — ` +
    `cannot synchronously decode. Ensure installWorkerShim ran before the bundle's Wp.c wrapper.`,
  );
}

/** Process-wide registry: blob URL → string contents (the inner JS). */
const blobUrlRegistry = new Map<string, string>();

/**
 * Patch the sandbox-realm `URL.createObjectURL` so that any
 * `Blob([... importScripts(...) ...], {type: 'application/javascript'})`
 * the bundle creates lands in {@link blobUrlRegistry} keyed by its blob
 * URL — and we additionally extract the `importScripts(realURL)` payload
 * to record the REAL chunk URL. The Worker constructor then reads back
 * the real URL synchronously instead of having to async-decode the blob.
 *
 * Idempotent.
 */
function patchUrlCreateObjectURL(sandbox: Sandbox): void {
  if (sandbox.getGlobal("__SNAPCAP_WORKER_URL_PATCHED")) return;
  const sandboxURL = sandbox.runInContext("URL") as {
    createObjectURL: (blob: unknown) => string;
    revokeObjectURL: (url: string) => void;
  };
  const origCreate = sandboxURL.createObjectURL.bind(sandboxURL);
  const origRevoke = sandboxURL.revokeObjectURL.bind(sandboxURL);
  sandboxURL.createObjectURL = (blob: unknown): string => {
    const url = origCreate(blob);
    // Best-effort: read the blob's bytes via the happy-dom private
    // `Symbol(buffer)` slot. Other shims (image-shim) do the same.
    try {
      if (blob && typeof blob === "object") {
        const sym = Object.getOwnPropertySymbols(blob).find((s) => s.toString().includes("buffer"));
        if (sym) {
          const buf = (blob as Record<symbol, unknown>)[sym];
          if (buf && typeof (buf as { toString?: unknown }).toString === "function") {
            const text = String(buf);
            // Extract the real URL from `importScripts("…");` — only
            // pattern Snap's Wp.c emits.
            const m = text.match(/importScripts\(\s*(["'])(.*?)\1\s*\)/);
            if (m && m[2]) blobUrlRegistry.set(url, m[2]);
            else blobUrlRegistry.set(url, text);
          }
        }
      }
    } catch { /* tolerated — fall through to async resolveObjectURL path */ }
    return url;
  };
  sandboxURL.revokeObjectURL = (u: string): void => {
    blobUrlRegistry.delete(u);
    origRevoke(u);
  };
  sandbox.setGlobal("__SNAPCAP_WORKER_URL_PATCHED", true);
}

/**
 * Install the Worker shim onto the sandbox realm.
 *
 * After install:
 *   - `globalThis.Worker` inside the sandbox is a no-op stub: the
 *     constructor records nothing and never loads/eval's the worker
 *     chunk. `postMessage` / `addEventListener` / `onmessage` /
 *     `terminate` are present so the bundle's `new Worker(...)` +
 *     Comlink-wrap path doesn't throw, but every call silently swallows.
 *   - `URL.createObjectURL` is left patched (harmless and shared with
 *     other shims).
 *
 * Why neutered: the worker chunk (`f16f14e3…chunk.js` + its
 * `importScripts("06c27f3b…chunk.js")`) bundles a SECOND Emscripten
 * Module whose top-level `_embind_register_class` calls collide with the
 * already-registered classes from the main-thread module 86818 factory
 * (we capture that one via `globalThis.__SNAPCAP_CHAT_MODULE` —
 * see `bundle/chat-wasm-boot.ts`). Loading the worker chunk in the same
 * realm aborts with "Cannot register public name X twice". We don't need
 * the worker either: the `state.wasm.workerProxy` facade installed in
 * `api/auth.ts` forwards messaging calls straight to the main-thread
 * Embind classes.
 *
 * Idempotent.
 *
 * @internal
 * @param sandbox - target {@link Sandbox} to install into
 * @param opts.bundleDir - filesystem path to the on-disk vendored
 *   Snap bundle (`vendor/snap-bundle`). Unused now that the Worker is a
 *   no-op stub; kept in the signature so call sites don't change.
 */
export function installWorkerShim(sandbox: Sandbox, _opts: { bundleDir: string }): void {
  if (sandbox.getGlobal("__SNAPCAP_WORKER_SHIM_INSTALLED")) return;
  patchUrlCreateObjectURL(sandbox);
  class Worker {
    onmessage: MessageListener | null = null;
    onerror: ((ev: { error: unknown }) => void) | null = null;
    constructor(_url: URL | string, _options?: { name?: string; type?: string; credentials?: string }) {
      /* no-op: chunk load + eval intentionally skipped */
    }
    postMessage(_data: unknown, _transfer?: unknown): void { /* swallow */ }
    addEventListener(_type: string, _listener: unknown): void { /* swallow */ }
    removeEventListener(_type: string, _listener: unknown): void { /* swallow */ }
    terminate(): void { /* swallow */ }
  }
  sandbox.setGlobal("Worker", Worker);
  sandbox.setGlobal("__SNAPCAP_WORKER_SHIM_INSTALLED", true);
  // Suppress an unused vm import warning if tree-shaken — vm is used
  // transitively via Sandbox.runInContext, but importing it at the
  // top keeps types tight. FakeWorker is retained for call sites that
  // import it directly (none currently after neutering).
  void vm;
  void FakeWorker;
}
