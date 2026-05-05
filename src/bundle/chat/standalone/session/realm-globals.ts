/**
 * Session-side realm-globals: top up the standalone realm with the
 * browser-shaped slots the f16f14e3 worker chunk + its dep graph probe
 * at module-eval time.
 *
 * The mint-side stubs in `../realm-globals.ts` are deliberately MINIMAL —
 * the mint path is pure WASM crypto and never touches `document` /
 * `addEventListener` / `BroadcastChannel`. The worker chunk DOES touch
 * those, plus `CustomEvent` / `Event` / `EventTarget` (via Zustand's
 * subscribe-with-CustomEvent dispatcher in module 89588).
 *
 * Idempotent — every patch is gated by a `typeof X === "function"` check
 * so the second `setupBundleSession` call against the same realm is a
 * cheap no-op rather than overwriting earlier wiring.
 *
 * @internal
 */

/**
 * Project the slot top-ups onto a standalone-realm globalThis. Safe to
 * call repeatedly.
 */
export function installSessionRealmGlobals(realmGlobal: Record<string, unknown>): void {
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
      throw new Error("Worker unavailable in standalone session realm");
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
      dispatchEvent(_ev: unknown): boolean {
        return true;
      }
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
      docAny.createElementNS = (_ns: string, tag: string) =>
        (docAny.createElement as Function)(tag);
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
      constructor(name: string) {
        this.name = name;
      }
      postMessage(_data: unknown): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    };
  }
  // requestIdleCallback — chat bundle uses this for background tasks.
  if (typeof realmGlobal.requestIdleCallback !== "function") {
    realmGlobal.requestIdleCallback = (
      cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
    ): number => {
      return setTimeout(
        () => cb({ didTimeout: false, timeRemaining: () => 50 }),
        0,
      ) as unknown as number;
    };
    realmGlobal.cancelIdleCallback = (id: number): void =>
      clearTimeout(id as unknown as NodeJS.Timeout);
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
  const realmURL = realmGlobal.URL as
    | { createObjectURL?: Function; revokeObjectURL?: Function }
    | undefined;
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
}
