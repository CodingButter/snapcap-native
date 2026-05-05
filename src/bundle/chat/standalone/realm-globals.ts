/**
 * Mint-realm globals: bare browser stubs the chat-bundle's runtime + main
 * top-level need to make it past their `typeof X === "function"` probes.
 *
 * Deliberately MINIMAL — the mint path doesn't touch `document` / `fetch` /
 * `Worker`; those are stubbed only so the early bundle init paths land
 * cleanly on `throw` instead of `TypeError`. The session bring-up
 * (`session/realm-globals.ts`) later beefs these up with the slots the
 * f16f14e3 chunk additionally probes.
 */

/**
 * Project the bare browser-shaped globals onto a fresh `vm.Context`'s
 * globalThis. Called once per mint-realm boot from `realm.ts`.
 *
 * @internal
 */
export function installMintRealmStubs(ctxGlobal: Record<string, unknown>): void {
  // Self-aliases so `self.webpackChunk_*` / `globalThis.X` / `window.Y`
  // all resolve to the same object.
  ctxGlobal.self = ctxGlobal;
  ctxGlobal.window = ctxGlobal;
  ctxGlobal.top = ctxGlobal;

  // Stubs the bundle's runtime + main top-level reach for. These never
  // get exercised — they exist only so `typeof X === 'function'` checks
  // pass during the brief window before main throws.
  ctxGlobal.console = console;
  ctxGlobal.setTimeout = setTimeout as unknown as typeof setTimeout;
  ctxGlobal.clearTimeout = clearTimeout as unknown as typeof clearTimeout;
  ctxGlobal.setInterval = setInterval as unknown as typeof setInterval;
  ctxGlobal.clearInterval = clearInterval as unknown as typeof clearInterval;
  ctxGlobal.queueMicrotask = queueMicrotask;
  ctxGlobal.TextEncoder = TextEncoder;
  ctxGlobal.TextDecoder = TextDecoder;
  ctxGlobal.URL = URL;
  ctxGlobal.URLSearchParams = URLSearchParams;
  ctxGlobal.atob = atob;
  ctxGlobal.btoa = btoa;
  ctxGlobal.crypto = globalThis.crypto;
  ctxGlobal.performance = performance;

  // Bundle reads `location.href` at top-level — give it a string-shaped stub.
  ctxGlobal.location = {
    href: "https://www.snapchat.com/web",
    pathname: "/web",
    origin: "https://www.snapchat.com",
    protocol: "https:",
    host: "www.snapchat.com",
    hostname: "www.snapchat.com",
    search: "",
    hash: "",
  };
  // Minimal navigator stub — bundle reads `navigator.userAgent` early.
  ctxGlobal.navigator = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    language: "en-US",
    languages: ["en-US", "en"],
    platform: "MacIntel",
    onLine: true,
  };
  // Minimal document stub — top-level React mount paths probe these.
  // Returning `null` from createElement / getElementById is enough to
  // make the bundle's mount path throw cleanly (which we catch).
  ctxGlobal.document = {
    body: { innerHTML: "" },
    head: { appendChild: () => {} },
    createElement: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { style: {} },
    cookie: "",
  };
  // Stub fetch / XMLHttpRequest as unimplemented. The mint path never
  // touches the network — only the bundle's React-mount path does, and
  // that throws cleanly on first reach.
  ctxGlobal.fetch = () => {
    throw new Error("fetch unavailable in mint realm");
  };
  ctxGlobal.XMLHttpRequest = function XMLHttpRequest() {
    throw new Error("XMLHttpRequest unavailable in mint realm");
  };
  ctxGlobal.Worker = function Worker() {
    throw new Error("Worker unavailable in mint realm");
  };
  ctxGlobal.WebSocket = function WebSocket() {
    throw new Error("WebSocket unavailable in mint realm");
  };
  ctxGlobal.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  ctxGlobal.sessionStorage = ctxGlobal.localStorage;
  ctxGlobal.indexedDB = {
    open: () => ({}),
  };
  ctxGlobal.requestAnimationFrame = (cb: (ts: number) => void): number => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  };
  ctxGlobal.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as NodeJS.Timeout);
  };
}
