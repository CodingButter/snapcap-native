/**
 * Sandbox `fetch` shim — replaces happy-dom's projected `fetch` with a
 * thin wrapper around Node's native `fetch` that's wired into our shared
 * tough-cookie jar and the sandbox's vm realm.
 *
 * Why this exists (empirical findings against happy-dom 18.x as projected
 * onto our sandbox by `BROWSER_PROJECTED_KEYS` in `sandbox.ts`):
 *
 *   1. CORS gate: happy-dom enforces a hard same-origin check against
 *      `window.location.href`. Our page URL is `https://www.snapchat.com/web`,
 *      so a fetch to ANY other origin (e.g. cf-st.sc-cdn.net for the chat
 *      bundle, accounts.snapchat.com for SSO) throws
 *      `Cross-Origin Request Blocked: The Same Origin Policy disallows
 *      reading the remote resource at "<url>"`. This blocks essentially
 *      every real request the bundle wants to make.
 *
 *   2. Mixed-content gate: any `http://` URL from the HTTPS page throws
 *      `Mixed Content: The page at 'https://...' was loaded over HTTPS,
 *      but requested an insecure XMLHttpRequest endpoint`. Some bundle
 *      paths (auto-detected dev configs, opaque redirects, edge debug
 *      hooks) hit http URLs; happy-dom blocks unconditionally.
 *
 *   3. No jar cookies: happy-dom's fetch has its own internal
 *      CookieContainer that we patch in `cookie-container.ts`, but the
 *      patch only routes happy-dom's OWN fetch path through the shared
 *      jar. The fetch happy-dom projects onto the global is a Node-style
 *      `fetch` wrapper that DOES NOT consult that container (bug or
 *      design — either way, `credentials: "include"` sends NO cookies).
 *      We've already confirmed this empirically: jar contains
 *      `probe_cookie=hello`, the request goes out with no `Cookie` header.
 *
 *   4. Cross-realm Response: even when happy-dom's fetch succeeds, the
 *      Response it returns is a host-realm Response. Bundle code does
 *      `response instanceof Response` against the SANDBOX's Response
 *      constructor, which fails silently — same realm-isolation footgun
 *      the cache-storage shim documents. We rebuild as sandbox-realm.
 *
 * Strategy:
 *   - Bypass happy-dom entirely. Use `nativeFetch` (Node's real fetch).
 *   - Attach Cookie header from the shared jar based on `credentials`.
 *   - Honor `redirect: "manual" | "follow" | "error"` faithfully (Node
 *     fetch supports all three; happy-dom does not surface the option).
 *   - Persist Set-Cookie back to the jar (mirrors the XHR shim's
 *     `absorbSetCookies` and the host-realm `transport/cookies.ts`).
 *   - Cross-realm: rebuild the Response with the sandbox-realm `Response`
 *     constructor, body bytes through `sandbox.toVmU8`, headers via the
 *     sandbox-realm `Headers` constructor.
 *
 * Body shape: we drain the body once via `arrayBuffer()` and rebuild the
 * sandbox-realm Response with the bytes. Bundle code that does
 * `response.text()` / `.json()` / `.arrayBuffer()` / `.body.getReader()`
 * all works because the rebuilt Response is a proper sandbox-realm
 * Response with a fresh body. We don't pipe streaming because Snap's
 * bundle paths (login `fetchToken`, gRPC-Web framed responses, media
 * uploads) all consume the body fully before acting on it; per-chunk
 * progress is the XHR shim's territory (`xml-http-request.ts:373-414`),
 * and that pattern stays scoped there.
 *
 * Same-origin policy: we treat any `*.snapchat.com` or `*.sc-cdn.net`
 * host as same-origin for `credentials: "same-origin"`. This matches the
 * actual deployment topology — every endpoint the bundle hits is one of
 * these two parent domains — without making us re-implement browser CORS
 * (which is enforced server-side anyway by Snap's CDN).
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
 * Best-effort byte count for a fetch body. See xml-http-request.ts for the
 * companion implementation — kept duplicated here to avoid a circular import
 * between the two shims (both shims import from logging.ts; pulling a util
 * out of either creates a dependency loop). Bodies are sized only — never
 * read for content. Unknown shapes return 0; we log sizes for observability,
 * not auditing, so a metric blip is acceptable.
 */
function byteLengthOf(body: unknown): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  const maybeSize = (body as { size?: unknown }).size;
  if (typeof maybeSize === "number") return maybeSize;
  return 0;
}

/** Hosts treated as same-origin for `credentials: "same-origin"`. */
const SAME_ORIGIN_SUFFIXES = [".snapchat.com", ".sc-cdn.net"];

/** True if `url`'s host is one of our trusted parent-domain suffixes. */
function isSnapOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SAME_ORIGIN_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
  } catch {
    return false;
  }
}

/** Decide whether to attach jar cookies based on `credentials` mode + URL. */
function shouldAttachCookies(
  credentials: RequestCredentials | undefined,
  url: string,
  pageUrl: string,
): boolean {
  // Spec default for fetch() is "same-origin"; treat undefined the same.
  const mode = credentials ?? "same-origin";
  if (mode === "omit") return false;
  if (mode === "include") return true;
  // "same-origin" — true if request URL same origin as page, OR the
  // request URL is one of our trusted Snap-family hosts (every real
  // bundle target falls in this bucket).
  try {
    const reqOrigin = new URL(url).origin;
    const pageOrigin = new URL(pageUrl).origin;
    if (reqOrigin === pageOrigin) return true;
  } catch {
    /* fall through to suffix check */
  }
  return isSnapOrigin(url);
}

/**
 * Normalize whatever shape `init.headers` arrives in (sandbox-realm
 * Headers, plain object, [k,v][] array, undefined) into a host-realm
 * Headers we can mutate before handing to nativeFetch.
 *
 * Cross-realm caveat: a sandbox-realm Headers fails `instanceof Headers`
 * against the host constructor. We can't rely on `instanceof`; instead
 * detect by duck-typing (`.forEach` is universal across realms).
 */
function normalizeHeaders(input: HeadersInit | undefined): Headers {
  const out = new Headers();
  if (!input) return out;
  // Plain array: [["k","v"], ...]
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length === 2) {
        out.append(String(pair[0]), String(pair[1]));
      }
    }
    return out;
  }
  // Headers-shaped (host or sandbox realm): has .forEach((value, key) => ...)
  const maybeForEach = (input as { forEach?: (cb: (v: string, k: string) => void) => void }).forEach;
  if (typeof maybeForEach === "function") {
    try {
      maybeForEach.call(input, (value: string, key: string) => {
        out.append(key, value);
      });
      return out;
    } catch {
      /* fall through to entries() / object iteration */
    }
  }
  // Plain object: { k: "v", ... }
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, string>)) {
      if (v !== undefined && v !== null) out.append(k, String(v));
    }
  }
  return out;
}

/**
 * Resolve a possibly-relative URL against the sandbox's current page URL.
 * Mirrors the XHR shim's `resolveUrl`.
 */
function resolveUrl(raw: string, sandbox: Sandbox): string {
  try {
    return new URL(raw).href;
  } catch {
    const base =
      ((sandbox.window as { location?: { href?: string } }).location?.href) ??
      "https://www.snapchat.com/web";
    return new URL(raw, base).href;
  }
}

/**
 * Extract `{ url, method, headers, body, credentials }` from a fetch()
 * `input` argument. `input` may be:
 *   - a string URL
 *   - a `URL` instance (host or sandbox realm)
 *   - a `Request` instance (host or sandbox realm; we duck-type)
 */
async function unpackInput(
  input: RequestInfo | URL,
  sandbox: Sandbox,
): Promise<{
  url: string;
  method?: string;
  headers?: Headers;
  body?: BodyInit | null;
  credentials?: RequestCredentials;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}> {
  if (typeof input === "string") return { url: resolveUrl(input, sandbox) };
  // URL instance — has `.href`. Cross-realm `instanceof URL` would fail;
  // duck-type instead.
  // Duck-type URL by `.href` — cross-realm `instanceof URL` would fail.
  // Note: Request has `.url`, not `.href`, so this won't trigger on Request.
  const maybeUrl = input as unknown as { href?: unknown };
  if (input instanceof URL || typeof maybeUrl.href === "string") {
    return { url: resolveUrl(maybeUrl.href as string, sandbox) };
  }
  // Otherwise treat as Request-shaped. Pull every relevant field; body
  // requires `arrayBuffer()` because Request bodies are streams.
  const req = input as Request;
  const url = resolveUrl(req.url, sandbox);
  const method = req.method;
  const headers = normalizeHeaders(req.headers as HeadersInit);
  let body: BodyInit | null = null;
  if (method !== "GET" && method !== "HEAD") {
    try {
      const ab = await req.arrayBuffer();
      if (ab.byteLength > 0) body = ab;
    } catch {
      /* body already consumed or no body */
    }
  }
  return {
    url,
    method,
    headers,
    body,
    credentials: req.credentials as RequestCredentials,
    redirect: req.redirect as RequestRedirect,
    signal: req.signal as AbortSignal | undefined,
  };
}

/**
 * Bridge a sandbox-realm AbortSignal into a host-realm AbortController so
 * cancellation propagates to nativeFetch. Returns the host controller (or
 * null if no signal was provided).
 *
 * The bundle's signal is from the sandbox realm; we can't pass it
 * directly to host-realm fetch (it would not satisfy the host's
 * `instanceof AbortSignal` check). Instead: subscribe to "abort" on the
 * sandbox signal, fire abort() on a fresh host controller.
 */
function bridgeSignal(sandboxSignal: AbortSignal | undefined): AbortController | null {
  if (!sandboxSignal) return null;
  const host = new AbortController();
  if (sandboxSignal.aborted) {
    host.abort();
    return host;
  }
  const onAbort = () => {
    try { host.abort(); } catch { /* ignore */ }
  };
  try {
    sandboxSignal.addEventListener("abort", onAbort, { once: true });
  } catch {
    /* malformed signal — proceed without bridge */
  }
  return host;
}

/**
 * Build the sandbox-realm fetch function. Mirrors the XHR shim's
 * `createNativeFetchXhr` factory — closure-captures realm constructors
 * + jar/store references.
 */
function createNativeFetchShim(opts: {
  jar: CookieJar;
  store: DataStore;
  sandbox: Sandbox;
  ua: string;
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const { jar, store, sandbox, ua } = opts;

  // Resolve sandbox-realm constructors once. Bundle code does
  // `response instanceof Response` against THESE — host-realm constructors
  // would fail the check silently (same footgun the cache-storage shim
  // documents in `cache-storage.ts:36-41`).
  const VmResponse = sandbox.runInContext("Response") as typeof Response;
  const VmHeaders = sandbox.runInContext("Headers") as typeof Headers;
  const VmReadableStream = sandbox.runInContext("ReadableStream") as typeof ReadableStream;
  void VmHeaders; // headers are passed as a plain object init below; this stays for symmetry

  return async function sandboxFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Merge `input`-derived defaults with `init` overrides. `init` wins
    // for any field it sets explicitly (per spec).
    const fromInput = await unpackInput(input, sandbox);
    const url = fromInput.url;
    const method = (init?.method ?? fromInput.method ?? "GET").toUpperCase();
    const credentials =
      (init?.credentials as RequestCredentials | undefined) ??
      fromInput.credentials ??
      "same-origin";
    const redirect =
      (init?.redirect as RequestRedirect | undefined) ??
      fromInput.redirect ??
      "follow";
    const signal =
      (init?.signal as AbortSignal | undefined) ?? fromInput.signal;

    // Headers: start from input.headers, then merge init.headers on top
    // (init wins per spec). Both shapes get normalized to host Headers.
    const headers = fromInput.headers ?? new Headers();
    if (init?.headers) {
      const initHdrs = normalizeHeaders(init.headers);
      initHdrs.forEach((value, key) => headers.set(key, value));
    }

    // Default UA — bundle code may not set one, and Node fetch would
    // otherwise send `node`. Match the SDK's default fingerprint.
    if (!headers.has("User-Agent")) headers.set("User-Agent", ua);

    // Cookies: attach Cookie header per credentials mode. Page URL
    // resolved at call time — sandbox.window.location may have shifted.
    const pageUrl =
      ((sandbox.window as { location?: { href?: string } }).location?.href) ??
      "https://www.snapchat.com/web";

    // Browser-context headers: real browsers attach Origin and Referer
    // automatically based on the page that issued the request. Node fetch
    // does not. Some Snap endpoints (notably accounts.snapchat.com SSO
    // refresh) silently 403 when these are missing — empirically verified
    // 2026-05-01: identical POST returns 200 with Origin+Referer set,
    // 403 without. Default both from the sandbox's current page URL;
    // honor explicit overrides set by the bundle (bundle wins).
    try {
      const pageOrigin = new URL(pageUrl).origin;
      if (!headers.has("Origin")) headers.set("Origin", pageOrigin);
      if (!headers.has("Referer")) {
        // Browser default is "strict-origin-when-cross-origin": send
        // origin-only for cross-origin, full URL for same-origin. Match
        // that — most Snap endpoints are cross-origin from the page URL.
        const reqOrigin = (() => { try { return new URL(url).origin; } catch { return ""; } })();
        headers.set("Referer", reqOrigin === pageOrigin ? pageUrl : pageOrigin + "/");
      }
    } catch {
      /* malformed pageUrl — skip browser-context headers */
    }
    if (shouldAttachCookies(credentials, url, pageUrl)) {
      try {
        const cookieHeader = jar.getCookieStringSync(url);
        if (cookieHeader) headers.set("Cookie", cookieHeader);
      } catch {
        /* malformed URL or jar lookup — proceed without cookies */
      }
    }

    // Body: undefined for GET/HEAD (per spec; passing a body would
    // throw), otherwise pass through. init.body wins over input.body.
    let body: BodyInit | null | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = (init?.body as BodyInit | null | undefined) ?? fromInput.body ?? null;
    }

    // AbortSignal bridge — sandbox-realm signal → host-realm controller.
    const hostCtrl = bridgeSignal(signal);

    // Per-Sandbox throttle gate. No-op when no throttle config was
    // configured at Sandbox construction. Per-instance state means two
    // SnapcapClients with different throttle configs don't collide.
    await sandbox.throttleGate(url);

    // Observability — emit open before issuing the request; record the
    // start time + outgoing body size so done/error events can compute
    // duration and req size without reaching back into init.
    const tStart = performance.now();
    const reqBytes = byteLengthOf(body);
    log({ kind: "net.fetch.open", method, url });

    // Fire the underlying fetch. Errors (network, abort, redirect with
    // mode:"error") propagate as-is — caller does `.catch()` per spec.
    let res: Response;
    try {
      res = await nativeFetch(url, {
        method,
        headers,
        body,
        signal: hostCtrl?.signal,
        redirect,
      });
    } catch (err) {
      // Log before re-throwing — bundle catches the rejection but our
      // observation pipeline shouldn't depend on whether it does.
      log({
        kind: "net.fetch.error",
        method,
        url,
        error: err instanceof Error ? err.message : String(err),
        durMs: performance.now() - tStart,
      });
      // Re-throw in sandbox realm where possible — bundle code may catch
      // with `instanceof TypeError`. Node fetch wraps everything in
      // TypeError already, but cross-realm checks would fail. Best-effort
      // by string message; bundle code typically just reads `.message`.
      throw err;
    }

    // Persist Set-Cookie headers back to the shared jar (mirrors
    // `xml-http-request.ts:absorbSetCookies` and `transport/cookies.ts`).
    // Skip when credentials:"omit" — matches browser semantics.
    if (credentials !== "omit") {
      let setCookies: string[] = [];
      try {
        setCookies = (res.headers as Headers & { getSetCookie?: () => string[] })
          .getSetCookie?.() ?? [];
      } catch {
        setCookies = [];
      }
      if (setCookies.length > 0) {
        let mutated = false;
        for (const raw of setCookies) {
          const parsed = Cookie.parse(raw);
          if (!parsed) continue;
          try {
            jar.setCookieSync(parsed, url);
            mutated = true;
          } catch {
            /* per-cookie rejection (public-suffix, expired, …) */
          }
        }
        if (mutated) persistJar(jar, store);
      }
    }

    // Drain the body and rebuild as a sandbox-realm Response.
    //
    // For redirect:"manual" Node returns a synthetic opaque-redirect
    // Response with status 0, type "opaqueredirect", and an empty body.
    // Most consumers just want to read the Location header; preserve it
    // as the *Snap-Original-Location* convention or — easier and what
    // the bundle's `fetchToken` actually does — read `response.headers
    // .get("location")`. Native fetch already preserves headers on the
    // opaque-redirect Response, so we just round-trip them.
    let bodyBytes: Uint8Array;
    try {
      const ab = await res.arrayBuffer();
      bodyBytes = new Uint8Array(ab);
    } catch {
      // opaqueredirect: arrayBuffer() returns empty; fall through.
      bodyBytes = new Uint8Array(0);
    }

    // Observability — emit done now that we have the full response in
    // hand. Includes gRPC trailer headers when present (the bundle uses
    // fetch for some gRPC-Web flows alongside the XHR transport).
    {
      const grpcStatus = res.headers.get("grpc-status") ?? undefined;
      const grpcMessage = res.headers.get("grpc-message") ?? undefined;
      log({
        kind: "net.fetch.done",
        method,
        url,
        status: res.status,
        reqBytes,
        respBytes: bodyBytes.byteLength,
        durMs: performance.now() - tStart,
        ...(grpcStatus !== undefined ? { grpcStatus } : {}),
        ...(grpcMessage !== undefined ? { grpcMessage } : {}),
      });
    }

    // Headers as plain object — sandbox-realm Response ctor accepts this.
    // Set-Cookie is intentionally INCLUDED here (unlike XHR's
    // getAllResponseHeaders) because fetch Response.headers DOES expose
    // Set-Cookie per spec (browsers gate it via Headers, not the
    // Response).
    const headerInit: [string, string][] = [];
    try {
      res.headers.forEach((value, key) => {
        headerInit.push([key, value]);
      });
    } catch {
      /* malformed headers — proceed empty */
    }

    // Sandbox-realm body bytes — required so cross-realm `Uint8Array`
    // checks pass (same constraint `Sandbox.toVmU8` exists for).
    const vmBytes = sandbox.toVmU8(bodyBytes);

    // Some statuses (204/205/304) reject a non-empty body in the Response
    // ctor; pass null for those.
    const noBodyStatus = res.status === 204 || res.status === 205 || res.status === 304;

    // CRITICAL realm subtlety: passing a `Uint8Array` directly to the
    // sandbox-realm Response ctor still wraps it in a HOST-realm internal
    // ReadableStream — when bundle code reads `response.body.getReader()`
    // and pulls a chunk, it gets a HOST-realm Uint8Array. Bundle protobuf
    // decoders (module 16237 protobufjs Reader) do `e instanceof Uint8Array`
    // against the SANDBOX `Uint8Array` and throw `"illegal buffer"`.
    //
    // This is exactly the same cross-realm footgun `Sandbox.toVmU8` exists
    // for — but for the chunks the response stream emits, not the body
    // input. Fix: build a sandbox-realm `ReadableStream` that enqueues the
    // sandbox-realm `Uint8Array`, then hand THAT stream to `VmResponse`.
    // Reading the stream then yields sandbox-realm chunks all the way down.
    //
    // Concrete failure mode (pre-fix): chat-bundle FriendAction mutations
    // (`AddFriends` etc.) failed with "Response closed without grpc-status
    // (Headers only)" because improbable-eng's grpc-web fetch transport
    // (module 37308) parsed the message chunk first; the protobuf reader
    // threw "illegal buffer", that exception was caught as a transport
    // error, and the trailer chunk (which carries `grpc-status: 0`) was
    // never parsed — so `responseTrailers` stayed undefined and the client
    // surfaced the false-negative "Headers only" message. Chat-side gRPC
    // works because it routes through the XHR shim (`xml-http-request.ts`),
    // which already projects each chunk into the sandbox via
    // `toVmArrayBuffer` — only the fetch shim needed the same treatment.
    const buildVmBodyStream = (bytes: Uint8Array): ReadableStream =>
      new VmReadableStream({
        start(ctrl: ReadableStreamDefaultController<Uint8Array>) {
          ctrl.enqueue(bytes);
          ctrl.close();
        },
      });

    let vmResponse: Response;
    try {
      vmResponse = new VmResponse(
        noBodyStatus || bodyBytes.byteLength === 0 ? null : buildVmBodyStream(vmBytes),
        {
          status: res.status,
          statusText: res.statusText || "",
          headers: headerInit,
        },
      );
    } catch {
      // Fallback: some Response impls reject statusText:"" for certain
      // statuses (e.g. 200). Retry without statusText.
      vmResponse = new VmResponse(
        noBodyStatus || bodyBytes.byteLength === 0 ? null : buildVmBodyStream(vmBytes),
        {
          status: res.status,
          headers: headerInit,
        },
      );
    }

    // `Response.url` is read-only on the constructor — there's no init field
    // for it. The rebuilt sandbox-realm response would otherwise have
    // `url=""`, which breaks bundle code that does `new URL(s.url)` to
    // inspect a redirect target. Per WHATWG fetch:
    //   - For `redirect:"manual"` (opaque-redirect responses), `Response.url`
    //     must be the ORIGINAL request URL.
    //   - For `redirect:"follow"`, `Response.url` is the FINAL URL after
    //     following.
    // Node's native fetch honors both, so prefer `res.url` when populated;
    // fall back to the resolved request URL only when native fetch returned
    // an empty string (defensive — some shapes may not set it).
    //
    // Concrete bundle hit: `chat-bundle` `refreshToken` does
    //   if (s.status >= 300 && s.status < 500)
    //     new URL(s.url).pathname.includes("accounts/verify") ? ... : ...
    // on the opaque-redirect from POST /accounts/sso. Without this override
    // we throw `"" cannot be parsed as a URL` and break refresh.
    try {
      Object.defineProperty(vmResponse, "url", {
        value: res.url || url,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    } catch {
      /* defineProperty rejected (already non-configurable) — leave as-is */
    }

    return vmResponse;
  };
}

/**
 * `Shim`-shaped wrapper. Overwrites `sandbox.window.fetch` (which
 * `BROWSER_PROJECTED_KEYS` populated with happy-dom's broken
 * implementation — see file header for empirical CORS / mixed-content /
 * jar-cookie / cross-realm bugs) with a Node-fetch-backed substrate that
 * rides the shared cookie jar and produces sandbox-realm Responses.
 *
 * Last-write-wins: this runs after the projection loop in {@link Sandbox}'s
 * constructor, so happy-dom's fetch is silently replaced before any
 * bundle code runs.
 *
 * @internal
 */
export class FetchShim extends Shim {
  /** @internal */
  readonly name = "fetch";

  /** @internal */
  install(sandbox: Sandbox, ctx: ShimContext): void {
    sandbox.window.fetch = createNativeFetchShim({
      jar: ctx.jar,
      store: ctx.dataStore,
      sandbox,
      ua: ctx.userAgent,
    });
  }
}
