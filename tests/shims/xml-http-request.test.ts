/**
 * NETWORK tests — `src/shims/xml-http-request.ts`
 *
 * Tests the XHR shim's observable interface.
 *
 * Because nativeFetch is an eagerly-snapshotted module-level binding,
 * we cannot stub it after module load. Tests are split into:
 *
 *   1. Pure lifecycle (no send) — open/readyState/abort/header API tests
 *      that don't require the request to complete.
 *   2. Network tests via a local Node http server — exercises the full
 *      send/load/loadend lifecycle against a real (localhost) response.
 *
 * The cookie attachment and Set-Cookie tests are done via the jar state
 * observable from the host realm.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";
import { getOrCreateJar } from "../../src/shims/cookie-jar.ts";

// ─── Local HTTP test server ───────────────────────────────────────────────────

let server: Server;
let port: number;
let lastReqHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      lastReqHeaders = Object.assign({}, req.headers);
      const url = req.url ?? "/";
      if (url.includes("/set-cookie")) {
        res.setHeader("Set-Cookie", "newcookie=val; Path=/");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("set-cookie-response");
      } else if (url.includes("/json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ msg: "hello" }));
      } else {
        res.writeHead(200, { "Content-Type": "text/plain", "x-custom": "yes" });
        res.end("hello world");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSandbox(): { sb: Sandbox; XHR: new () => XMLHttpRequest; store: MemoryDataStore } {
  const store = new MemoryDataStore();
  const sb = new Sandbox({ dataStore: store, userAgent: "TestXHR/1" });
  const XHR = (sb.window as unknown as { XMLHttpRequest: new () => XMLHttpRequest }).XMLHttpRequest;
  return { sb, XHR, store };
}

function waitForDone(xhr: XMLHttpRequest): Promise<void> {
  return new Promise((resolve) => {
    if (xhr.readyState === 4) { resolve(); return; }
    xhr.addEventListener("loadend", () => resolve());
  });
}

// ─── Pure lifecycle tests (no send) ──────────────────────────────────────────

describe("shims/xml-http-request — open / readyState (no network)", () => {
  test("open() sets readyState to OPENED (1)", () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    expect(xhr.readyState).toBe(0);
    xhr.open("GET", "http://localhost/");
    expect(xhr.readyState).toBe(1);
  });

  test("setRequestHeader in OPENED state does not throw", () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    xhr.open("GET", "http://localhost/");
    expect(() => xhr.setRequestHeader("X-Test", "yes")).not.toThrow();
  });

  test("setRequestHeader outside OPENED state throws", () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    expect(() => xhr.setRequestHeader("X-Test", "no")).toThrow();
  });

  test("XMLHttpRequest is defined on sandbox window", () => {
    const { XHR } = makeSandbox();
    expect(typeof XHR).toBe("function");
  });
});

describe("shims/xml-http-request — abort (no network)", () => {
  test("abort() fires abort + loadend and sets readyState=4", async () => {
    const { XHR } = makeSandbox();
    // Point to a server that never responds — use a port that's likely not listening.
    const xhr = new XHR();
    let abortFired = false;
    let loadendFired = false;
    xhr.onabort = () => { abortFired = true; };
    xhr.onloadend = () => { loadendFired = true; };
    // Open against a real host so nativeFetch can start — but abort immediately.
    xhr.open("GET", `http://127.0.0.1:${port}/`);
    xhr.send();
    xhr.abort();
    expect(abortFired).toBe(true);
    expect(loadendFired).toBe(true);
    expect(xhr.readyState).toBe(4);
  });
});

describe("shims/xml-http-request — response headers API (no network)", () => {
  test("getResponseHeader returns null for set-cookie", () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    // getResponseHeader before a request returns null.
    expect(xhr.getResponseHeader("set-cookie")).toBeNull();
  });

  test("getAllResponseHeaders returns empty string before send", () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    expect(xhr.getAllResponseHeaders()).toBe("");
  });
});

// ─── Network tests (localhost) ────────────────────────────────────────────────

describe("shims/xml-http-request — send/load lifecycle (localhost)", () => {
  test("load event fires with readyState=4 and correct status", async () => {
    const { XHR } = makeSandbox();
    let loadFired = false;
    const xhr = new XHR();
    xhr.onload = () => { loadFired = true; };
    xhr.open("GET", `http://127.0.0.1:${port}/`);
    xhr.send();
    await waitForDone(xhr);
    expect(loadFired).toBe(true);
    expect(xhr.readyState).toBe(4);
    expect(xhr.status).toBe(200);
  });

  test("responseText is populated for text responseType", async () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    xhr.open("GET", `http://127.0.0.1:${port}/`);
    xhr.send();
    await waitForDone(xhr);
    expect(xhr.responseText).toBe("hello world");
  });

  test("getAllResponseHeaders excludes set-cookie, includes x-custom", async () => {
    const { XHR } = makeSandbox();
    const xhr = new XHR();
    xhr.open("GET", `http://127.0.0.1:${port}/`);
    xhr.send();
    await waitForDone(xhr);
    const all = xhr.getAllResponseHeaders();
    expect(all.toLowerCase()).not.toContain("set-cookie");
    expect(all.toLowerCase()).toContain("x-custom");
  });

  test("Set-Cookie is persisted to jar when withCredentials=true", async () => {
    const { XHR, store } = makeSandbox();
    const xhr = new XHR();
    xhr.withCredentials = true;
    xhr.open("GET", `http://127.0.0.1:${port}/set-cookie`);
    xhr.send();
    await waitForDone(xhr);
    const jar = getOrCreateJar(store);
    const cookies = jar.getCookiesSync(`http://127.0.0.1:${port}/`);
    expect(cookies.some((c) => c.key === "newcookie")).toBe(true);
  });
}, 15_000);
