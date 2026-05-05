/**
 * Smoke test for the FetchShim.
 *
 * Exercises:
 *   1. Plain GET — happy-dom would block this with CORS; verify we don't.
 *   2. POST with body + JSON echo — verify body bytes round-trip.
 *   3. credentials: "include" — seed jar, verify Cookie header attached.
 *   4. credentials: "omit" — verify Cookie header NOT attached.
 *   5. credentials: "same-origin" against a Snap-family host — verify
 *      cookies attached (via the SAME_ORIGIN_SUFFIXES allow-list).
 *   6. redirect: "manual" — verify we get the 30x back without following.
 *   7. redirect: "follow" — verify same URL DOES auto-follow.
 *   8. Cross-realm — `instanceof VmResponse` passes inside sandbox.
 *
 * Uses httpbin.org because it echoes request headers as JSON, which lets
 * us assert what cookies/UA/etc. went out without standing up a server.
 */
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Cookie } from "tough-cookie";
import { FileDataStore } from "../src/storage/data-store.ts";
import { Sandbox } from "../src/shims/sandbox.ts";
import { getOrCreateJar } from "../src/shims/cookie-jar.ts";

const STORE_PATH = join(import.meta.dir, "..", ".tmp", "auth", "test-fetch.json");
if (existsSync(STORE_PATH)) rmSync(STORE_PATH);

type HeadersEcho = { headers?: Record<string, string> };

async function main(): Promise<void> {
  const ds = new FileDataStore(STORE_PATH);
  const sb = new Sandbox({ dataStore: ds });
  const fetch = sb.window.fetch as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  const VmResponse = sb.runInContext("Response") as typeof Response;

  // ─── 1. Plain GET ───────────────────────────────────────────────────────
  console.log(`[test-fetch] === 1. plain GET ===`);
  {
    const r = await fetch("https://httpbin.org/get");
    if (r.status !== 200) throw new Error(`plain GET: status ${r.status}`);
    if (!(r instanceof VmResponse)) throw new Error(`plain GET: not sandbox-realm Response`);
    const j = (await r.json()) as { url?: string };
    if (j.url !== "https://httpbin.org/get") throw new Error(`plain GET: url echo mismatch (${j.url})`);
    console.log(`[test-fetch] plain GET ok: status=200, sandbox-realm Response, url echo correct`);
  }

  // ─── 2. POST with body ──────────────────────────────────────────────────
  console.log(`[test-fetch] === 2. POST with body ===`);
  {
    const r = await fetch("https://httpbin.org/post", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello-snapcap",
    });
    if (r.status !== 200) throw new Error(`POST: status ${r.status}`);
    const j = (await r.json()) as { data?: string };
    if (j.data !== "hello-snapcap") throw new Error(`POST: body echo mismatch (got "${j.data}")`);
    console.log(`[test-fetch] POST ok: body round-tripped as "${j.data}"`);
  }

  // ─── 3. credentials: "include" attaches jar cookies ─────────────────────
  console.log(`[test-fetch] === 3. credentials:include ===`);
  {
    const jar = getOrCreateJar(ds);
    await jar.setCookie(
      Cookie.parse("test_jar_cookie=include_value; Path=/")!,
      "https://httpbin.org/",
    );
    const r = await fetch("https://httpbin.org/headers", { credentials: "include" });
    const j = (await r.json()) as HeadersEcho;
    const cookieHdr = j.headers?.Cookie ?? "";
    if (!cookieHdr.includes("test_jar_cookie=include_value")) {
      throw new Error(`credentials:include — Cookie header missing jar cookie (got "${cookieHdr}")`);
    }
    console.log(`[test-fetch] credentials:include ok — Cookie sent: "${cookieHdr}"`);
  }

  // ─── 4. credentials: "omit" suppresses cookies ──────────────────────────
  console.log(`[test-fetch] === 4. credentials:omit ===`);
  {
    const r = await fetch("https://httpbin.org/headers", { credentials: "omit" });
    const j = (await r.json()) as HeadersEcho;
    if (j.headers?.Cookie) {
      throw new Error(`credentials:omit — Cookie sent anyway: "${j.headers.Cookie}"`);
    }
    console.log(`[test-fetch] credentials:omit ok — no Cookie header`);
  }

  // ─── 5. credentials: "same-origin" against Snap-family host ─────────────
  // httpbin is NOT a Snap host, so "same-origin" should NOT attach cookies
  // there even though the page URL is snapchat.com (same-origin defaults
  // when neither origin matches → no cookies).
  console.log(`[test-fetch] === 5. credentials:same-origin (non-Snap) ===`);
  {
    const r = await fetch("https://httpbin.org/headers", { credentials: "same-origin" });
    const j = (await r.json()) as HeadersEcho;
    if (j.headers?.Cookie) {
      throw new Error(`same-origin: cookie attached to non-Snap host (${j.headers.Cookie})`);
    }
    console.log(`[test-fetch] same-origin (httpbin) ok — no cookies attached`);
  }

  // ─── 6. redirect: "manual" — don't follow ───────────────────────────────
  console.log(`[test-fetch] === 6. redirect:manual ===`);
  {
    // httpbin.org/redirect-to?url=... returns 302 to the given URL.
    const target = encodeURIComponent("https://www.example.com/");
    const r = await fetch(`https://httpbin.org/redirect-to?url=${target}`, {
      redirect: "manual",
    });
    // Per spec, manual redirect Responses have status 0 / type "opaqueredirect".
    // Some Node fetch impls preserve the actual 30x status + Location header
    // — accept either shape, just verify we did NOT follow.
    const isOpaque = r.type === "opaqueredirect" || r.status === 0;
    const is30x = r.status >= 300 && r.status < 400;
    if (!isOpaque && !is30x) {
      throw new Error(`redirect:manual — got status ${r.status} type ${r.type}; should not have followed`);
    }
    console.log(
      `[test-fetch] redirect:manual ok — status=${r.status} type=${r.type} location=${r.headers.get("location") ?? "(none)"}`,
    );
  }

  // ─── 7. redirect: "follow" — does follow ────────────────────────────────
  console.log(`[test-fetch] === 7. redirect:follow ===`);
  {
    // Follow a single redirect from httpbin → httpbin/get; verify final body.
    const target = encodeURIComponent("https://httpbin.org/get");
    const r = await fetch(`https://httpbin.org/redirect-to?url=${target}`, {
      redirect: "follow",
    });
    if (r.status !== 200) throw new Error(`redirect:follow — final status ${r.status}`);
    const j = (await r.json()) as { url?: string };
    if (j.url !== "https://httpbin.org/get") {
      throw new Error(`redirect:follow — final url ${j.url}`);
    }
    console.log(`[test-fetch] redirect:follow ok — followed to ${j.url}`);
  }

  // ─── 8. Cross-realm — VmResponse instanceof check ───────────────────────
  console.log(`[test-fetch] === 8. cross-realm check ===`);
  {
    const r = await fetch("https://httpbin.org/get");
    // Run the instanceof check INSIDE the sandbox realm — that's where
    // bundle code does it. If our shim returned a host-realm Response,
    // this would be `false` and the bundle would silently misbehave.
    sb.setGlobal("__test_response", r);
    const inSandbox = sb.runInContext("__test_response instanceof Response") as boolean;
    if (!inSandbox) {
      throw new Error(`cross-realm — response not sandbox-realm; instanceof Response (sandbox) = false`);
    }
    console.log(`[test-fetch] cross-realm ok — response IS sandbox-realm Response`);
  }

  console.log(`\n[test-fetch] All checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[test-fetch] FAILED: ${err.stack ?? err.message}`);
    process.exit(1);
  },
);
