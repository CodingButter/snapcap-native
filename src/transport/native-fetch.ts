/**
 * Node/Bun's real `fetch`, used by the SDK for actual network traffic
 * (login, gRPC, media uploads). All Set-Cookie headers reach our cookie
 * jar through this reference because happy-dom's cookie-stripping fetch
 * never lands on the host globalThis — `installShims()` keeps happy-dom
 * scoped to the sandbox vm.Context (see `shims/sandbox.ts`).
 *
 * Eager-binding is preserved as defence-in-depth: if a future change ever
 * regresses sandbox isolation (e.g. someone reaches for GlobalRegistrator),
 * snapshotting at module load means we still get the un-shimmed fetch.
 *
 * Observability: this is the single chokepoint for HOST-realm traffic, so
 * we wrap the snapshotted fetch in a logging adapter that emits
 * net.fetch.{open,done,error} via `logging.ts`. The sandbox `fetch` shim
 * (`shims/fetch.ts`) emits its OWN events from inside the sandbox before
 * delegating here; both layers log so consumers see every hop. When no
 * logger is installed `log()` is a no-op — zero perf cost.
 */
import { log } from "../logging.ts";

/**
 * Eager snapshot of the un-shimmed fetch. Kept around so the wrapper has a
 * stable reference even if a future shim hooks `globalThis.fetch`.
 *
 * Throttling is NOT applied here — it lives per-Sandbox at
 * `Sandbox.throttleGate`, which the sandbox shims (`shims/fetch.ts`,
 * `shims/xml-http-request.ts`) await before calling into this layer.
 * Direct callers (e.g. login's SSO redirect dance) bypass throttling
 * by design — login is per-account and not the multi-instance concern.
 */
const snapshotFetch = globalThis.fetch.bind(globalThis);

/** Best-effort byte size of an outgoing fetch body. Sizes only, never content. */
function bodyByteLength(body: BodyInit | null | undefined): number {
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

/** Resolve a fetch input arg to a string URL for logging. */
function inputToUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  // Request-like — has `.url`.
  const r = input as { url?: unknown };
  if (typeof r.url === "string") return r.url;
  return String(input);
}

/** Resolve method from init (preferred) or input (Request fallback). */
function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = init?.method;
  if (typeof fromInit === "string") return fromInit.toUpperCase();
  const r = input as { method?: unknown };
  if (typeof r.method === "string") return r.method.toUpperCase();
  return "GET";
}

/**
 * Logging wrapper around the snapshotted fetch. Same signature as the
 * native fetch, plus net.fetch.* events emitted on every call. The body
 * stream of the returned Response is NOT read here — consumers continue to
 * call `.json()` / `.text()` / `.arrayBuffer()` themselves — so we report
 * `respBytes: 0` from the wrapper. Per-shim wrappers (the sandbox fetch
 * shim and the XHR shim) both drain bodies themselves and log accurate
 * sizes from there; this layer reports the request shape + status only.
 */
async function loggingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = inputToUrl(input);
  const method = resolveMethod(input, init);
  const reqBytes = bodyByteLength(init?.body ?? null);
  const tStart = performance.now();
  log({ kind: "net.fetch.open", method, url });
  let res: Response;
  try {
    res = await snapshotFetch(input, init);
  } catch (err) {
    log({
      kind: "net.fetch.error",
      method,
      url,
      error: err instanceof Error ? err.message : String(err),
      durMs: performance.now() - tStart,
    });
    throw err;
  }
  // We don't drain the body here (would change semantics for stream
  // consumers like the gRPC-Web framing reader). respBytes:0 reflects
  // "wrapper didn't measure" — the layer that consumes the body knows
  // its size and can log a follow-up event if desired.
  const grpcStatus = res.headers.get("grpc-status") ?? undefined;
  const grpcMessage = res.headers.get("grpc-message") ?? undefined;
  log({
    kind: "net.fetch.done",
    method,
    url,
    status: res.status,
    reqBytes,
    respBytes: 0,
    durMs: performance.now() - tStart,
    ...(grpcStatus !== undefined ? { grpcStatus } : {}),
    ...(grpcMessage !== undefined ? { grpcMessage } : {}),
  });
  return res;
}

export const nativeFetch: typeof fetch = loggingFetch as typeof fetch;
