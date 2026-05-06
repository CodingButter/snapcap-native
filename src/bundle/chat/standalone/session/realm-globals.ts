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
 * Parse intrinsic dimensions from the leading bytes of a supported image
 * format. PNG, JPEG, and WebP (VP8 / VP8L / VP8X) — the formats the bundle's
 * media-send path actually receives. GIF and SVG surface a clear "unsupported
 * format" error so the next iteration knows what to add.
 *
 * @internal
 */
function readImageDimensions(buf: Uint8Array): { width: number; height: number } {
  if (buf.length < 8) {
    throw new Error("readImageDimensions: buffer too short");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // PNG: signature "\x89PNG\r\n\x1a\n" + IHDR chunk header at offsets 8-15;
  // width is the big-endian uint32 at 16-19, height at 20-23.
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // JPEG: 0xFF 0xD8 marker + scan for SOFn (0xFF 0xC0..0xC3, 0xC5..0xC7,
  // 0xC9..0xCB, 0xCD..0xCF). Each marker is followed by a 2-byte big-endian
  // length, 1-byte precision, then height (uint16 BE), width (uint16 BE).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === undefined) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: dv.getUint16(i + 7, false), height: dv.getUint16(i + 5, false) };
      }
      const segLen = dv.getUint16(i + 2, false);
      i += 2 + segLen;
    }
    throw new Error("readImageDimensions: JPEG SOF marker not found");
  }
  // WebP: "RIFF" + size + "WEBP" + chunk type ("VP8 ", "VP8L", "VP8X").
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    // VP8 (lossy): width/height at offsets 26-27 / 28-29 as uint16 LE,
    // dimensions in the low 14 bits.
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
      return {
        width: dv.getUint16(26, true) & 0x3fff,
        height: dv.getUint16(28, true) & 0x3fff,
      };
    }
    // VP8L (lossless): 4-byte signature 0x2f at offset 20, then width-1 (14
    // bits) and height-1 (14 bits) packed across offsets 21-24.
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c) {
      const b21 = buf[21]!, b22 = buf[22]!, b23 = buf[23]!, b24 = buf[24]!;
      const wMinus1 = ((b22 & 0x3f) << 8) | b21;
      const hMinus1 = ((b24 & 0x0f) << 10) | (b23 << 2) | ((b22 & 0xc0) >> 6);
      return { width: wMinus1 + 1, height: hMinus1 + 1 };
    }
    // VP8X (extended): width-1 at offset 24-26 (3 bytes LE), height-1 at 27-29.
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
      const wMinus1 = buf[24]! | (buf[25]! << 8) | (buf[26]! << 16);
      const hMinus1 = buf[27]! | (buf[28]! << 8) | (buf[29]! << 16);
      return { width: wMinus1 + 1, height: hMinus1 + 1 };
    }
    throw new Error("readImageDimensions: unrecognized WebP variant");
  }
  const head = Array.from(buf.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  throw new Error(`readImageDimensions: unsupported format (head: ${head})`);
}

/**
 * Install a cookie-attached `fetch` on the standalone-realm `globalThis`.
 * The mint-realm boot leaves a stub that throws "fetch unavailable in
 * mint realm"; the session realm reuses that boot, so we have to override.
 *
 * The bundle's media-upload path (`Fi.uploadMedia`) calls fetch to PUT
 * media bytes to Snap's CDN; without this, the path silently hangs in a
 * promise chain that catches the throw and never resolves.
 *
 * Pass the `setupBundleSession` cookieJar + userAgent through the existing
 * `makeJarFetch` host-realm wrapper — same plumbing the WebSocket shim
 * uses for its upgrade GET.
 *
 * @param realmGlobal - The standalone realm's globalThis (from
 *   `vm.runInContext("globalThis", context)`).
 * @param fetch - A pre-bound fetch function (typically built via
 *   `makeJarFetch(cookieJar, userAgent)` in `setup.ts`).
 *
 * @internal
 */
export function installSessionRealmFetch(
  realmGlobal: Record<string, unknown>,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
): void {
  realmGlobal.fetch = fetch;
}

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
  // URL.createObjectURL + Image — used by the bundle's media send pipeline
  // (sendImage / sendSnap / stories.post). The bundle calls
  // `URL.createObjectURL(blob)` to get a handle, then `new Image()` with
  // `src = handle`, and reads `naturalWidth` / `naturalHeight` to drive
  // the 1080×1920 normalization canvas. happy-dom's HTMLImageElement is a
  // no-op stub (`naturalWidth = 0`), so we install our own pair: a
  // Map-backed createObjectURL and an Image shim that parses image headers
  // directly from the blob bytes.
  const realmURL = realmGlobal.URL as
    | { createObjectURL?: Function; revokeObjectURL?: Function }
    | undefined;
  // Force-install: happy-dom ships a `URL.createObjectURL` that mints
  // UUID-style URLs and stores blobs in a private map we can't read, so
  // our `Image` shim couldn't look them up. Replace unconditionally to
  // route both ends through our shared registry.
  if (realmURL && !realmGlobal.__snapcap_objectURLs) {
    const registry = new Map<string, Blob>();
    realmGlobal.__snapcap_objectURLs = registry;
    let counter = 0;
    realmURL.createObjectURL = (blob: Blob): string => {
      counter += 1;
      const url = `blob:snapcap-realm-${counter}`;
      registry.set(url, blob);
      return url;
    };
    realmURL.revokeObjectURL = (url: string): void => {
      registry.delete(url);
    };
  }
  // Force-install Image too — happy-dom's HTMLImageElement is a no-op
  // stub (`naturalWidth = 0`), so even if it's already on the realm we
  // need ours.
  if (!realmGlobal.__snapcap_image_shim_installed) {
    realmGlobal.__snapcap_image_shim_installed = true;
    realmGlobal.Image = function ShimImage(this: Record<string, unknown>): void {
      const registry = realmGlobal.__snapcap_objectURLs as Map<string, Blob> | undefined;
      let src = "";
      let naturalWidth = 0;
      let naturalHeight = 0;
      let onload: ((ev?: unknown) => void) | null = null;
      let onerror: ((ev?: unknown) => void) | null = null;
      const img = this;
      Object.defineProperty(img, "src", {
        get: () => src,
        set: (v: string): void => {
          src = v;
          queueMicrotask(async () => {
            try {
              const blob = registry?.get(v);
              if (!blob) throw new Error(`Image: unknown blob URL ${v}`);
              const buf = new Uint8Array(await blob.arrayBuffer());
              const dims = readImageDimensions(buf);
              naturalWidth = dims.width;
              naturalHeight = dims.height;
              if (process.env.SNAPCAP_DEBUG_IMAGE === "1") {
                process.stderr.write(`[Image.shim] src=${v} size=${buf.byteLength} dims=${dims.width}x${dims.height}\n`);
              }
              onload?.({ target: img });
            } catch (err) {
              if (process.env.SNAPCAP_DEBUG_IMAGE === "1") {
                process.stderr.write(`[Image.shim] FAIL src=${v} err=${(err as Error).message}\n`);
              }
              onerror?.({ target: img, error: err });
            }
          });
        },
      });
      Object.defineProperty(img, "onload", {
        get: () => onload,
        set: (v) => { onload = v as typeof onload; },
      });
      Object.defineProperty(img, "onerror", {
        get: () => onerror,
        set: (v) => { onerror = v as typeof onerror; },
      });
      Object.defineProperty(img, "naturalWidth", { get: () => naturalWidth });
      Object.defineProperty(img, "naturalHeight", { get: () => naturalHeight });
      Object.defineProperty(img, "width", { get: () => naturalWidth });
      Object.defineProperty(img, "height", { get: () => naturalHeight });
    } as unknown as new () => unknown;
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
