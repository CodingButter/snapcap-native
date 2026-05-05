/**
 * NETWORK tests — `src/shims/websocket.ts`
 *
 * WebSocketShim wraps Node's `ws` package. Tests that can run offline
 * exercise the constructor / API surface shape without opening a real
 * network connection (we can't do that in unit tests).
 *
 * Strategy: verify that the shim installs correctly on a Sandbox, that
 * the resulting class has the expected static/instance properties, and
 * that the shim is per-Sandbox isolated. Actual network connectivity
 * (real WS handshake to aws.duplex.snapchat.com) is LIVE-ONLY.
 *
 * Note: constructing a SandboxWebSocket with a real URL WILL attempt to
 * connect. We do NOT do that here. We only inspect the class/prototype.
 */
import { describe, expect, test } from "bun:test";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { MemoryDataStore } from "../../src/storage/data-store.ts";

function makeSandbox(): Sandbox {
  return new Sandbox({ dataStore: new MemoryDataStore(), userAgent: "TestWS/1" });
}

describe("shims/websocket — install check", () => {
  test("sandbox.window.WebSocket is a constructor after Sandbox construction", () => {
    const sb = makeSandbox();
    const WS = (sb.window as unknown as { WebSocket: unknown }).WebSocket;
    expect(WS).toBeDefined();
    expect(typeof WS).toBe("function");
  });

  test("WebSocket has CONNECTING/OPEN/CLOSING/CLOSED static constants", () => {
    const sb = makeSandbox();
    const WS = (sb.window as unknown as { WebSocket: Record<string, unknown> }).WebSocket;
    expect(WS["CONNECTING"]).toBe(0);
    expect(WS["OPEN"]).toBe(1);
    expect(WS["CLOSING"]).toBe(2);
    expect(WS["CLOSED"]).toBe(3);
  });

  test("two Sandboxes have distinct WebSocket classes", () => {
    const sbA = makeSandbox();
    const sbB = makeSandbox();
    const WSA = (sbA.window as unknown as { WebSocket: unknown }).WebSocket;
    const WSB = (sbB.window as unknown as { WebSocket: unknown }).WebSocket;
    // Each Sandbox installs a locally-scoped class via the Shim closure.
    // They must not be the same reference.
    expect(WSA).not.toBe(WSB);
  });
});
