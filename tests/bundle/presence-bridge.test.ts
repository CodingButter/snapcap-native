/**
 * STATE-DRIVEN tests — `src/bundle/presence-bridge.ts`.
 *
 * `createPresenceBridge` builds a PresenceDuplexClient from a StandaloneChatRealm
 * and a Sandbox. It's the cross-realm bridge between En.registerDuplexHandler
 * (standalone realm) and the chat-bundle's presence layer.
 *
 * For unit tests we don't need a real vm.Context: we provide a minimal
 * `realm` whose `.context` has `__SNAPCAP_EN` set via
 * `vm.runInContext("globalThis", ctx).__SNAPCAP_EN = ...`.
 *
 * Tests cover:
 *   (a) throws when realm has no __SNAPCAP_EN
 *   (b) registerHandler → calls En.registerDuplexHandler
 *   (c) addStreamListener → synchronously fires READY=1
 *   (d) removeStreamListener → no-op, no throw
 *   (e) unregisterHandler with a cached handle → calls handle.unregisterHandler
 *   (f) send with a cached handle → calls handle.send + fires onSend
 *   (g) send with no handle → fires onError("UNAVAILABLE")
 *   (h) no-op methods (appStateChanged, dispose, disposeAsync) → no throw
 *   (i) inbound onReceive → projects bytes to chat realm Uint8Array
 */
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { createPresenceBridge } from "../../src/bundle/presence-bridge.ts";
import { mockSandbox } from "../lib/mock-sandbox.ts";
import { chatStateFixture } from "../lib/fixtures/index.ts";
import type { StandaloneChatRealm } from "../../src/auth/fidelius-mint.ts";

// Build a minimal StandaloneChatRealm with a controllable __SNAPCAP_EN
function makeRealm(enOverride?: unknown): StandaloneChatRealm {
  const context = vm.createContext({});
  const g = vm.runInContext("globalThis", context) as Record<string, unknown>;
  if (enOverride !== undefined) {
    g.__SNAPCAP_EN = enOverride;
  }
  return { context, moduleEnv: {} } as unknown as StandaloneChatRealm;
}

function makeEn(opts: {
  registerDuplexHandler?: (path: string, handler: { onReceive: (b: Uint8Array) => void }) => unknown;
} = {}) {
  const registeredHandlers: Array<{
    channel: string;
    handler: { onReceive: (b: Uint8Array) => void };
  }> = [];
  return {
    _registered: registeredHandlers,
    registerDuplexHandler: opts.registerDuplexHandler ?? (async (channel, handler) => {
      registeredHandlers.push({ channel, handler });
      return {
        send: () => {},
        unregisterHandler: () => {},
      };
    }),
  };
}

describe("bundle/presence-bridge — createPresenceBridge", () => {
  test("throws when realm has no __SNAPCAP_EN", () => {
    const realm = makeRealm(); // no En
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    expect(() => createPresenceBridge(realm, sandbox)).toThrow(
      "createPresenceBridge: standalone realm has no __SNAPCAP_EN",
    );
  });

  test("throws when __SNAPCAP_EN has no registerDuplexHandler", () => {
    const realm = makeRealm({ notADuplexEngine: true });
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    expect(() => createPresenceBridge(realm, sandbox)).toThrow(
      "createPresenceBridge",
    );
  });

  test("addStreamListener fires READY=1 synchronously", () => {
    const en = makeEn();
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    const statuses: (number | string | boolean)[] = [];
    bridge.addStreamListener({ onStreamStatusChanged: (s) => statuses.push(s) });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toBe(1);
  });

  test("removeStreamListener is a no-op and does not throw", () => {
    const en = makeEn();
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    expect(() => bridge.removeStreamListener({}, "tag")).not.toThrow();
  });

  test("appStateChanged / dispose / disposeAsync are no-throw no-ops", () => {
    const en = makeEn();
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    expect(() => bridge.appStateChanged("state")).not.toThrow();
    expect(() => bridge.dispose()).not.toThrow();
    expect(() => bridge.disposeAsync()).not.toThrow();
  });

  test("registerHandler triggers En.registerDuplexHandler", async () => {
    const registerCalls: string[] = [];
    const en = makeEn({
      registerDuplexHandler: async (channel) => {
        registerCalls.push(channel);
        return { send: () => {}, unregisterHandler: () => {} };
      },
    });
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    bridge.registerHandler("pcs", { onReceive: () => {} });

    // Give the async registration a tick to complete
    await new Promise((r) => setTimeout(r, 20));
    expect(registerCalls).toContain("pcs");
  });

  test("send with no cached handle fires onError", () => {
    const en = makeEn();
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    const errors: unknown[] = [];
    bridge.send("pcs", new Uint8Array([1, 2, 3]), {
      onError: (e) => errors.push(e),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("UNAVAILABLE");
  });

  test("send with a cached handle calls handle.send and fires onSend", async () => {
    const sendCalls: Array<{ channel: string; bytes: Uint8Array }> = [];
    const en = makeEn({
      registerDuplexHandler: async (channel) => ({
        send: (ch: string, bytes: Uint8Array) => sendCalls.push({ channel: ch, bytes }),
        unregisterHandler: () => {},
      }),
    });
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    bridge.registerHandler("pcs", { onReceive: () => {} });
    await new Promise((r) => setTimeout(r, 20));

    const onSendCalls: number[] = [];
    const bytes = new Uint8Array([10, 20]);
    bridge.send("pcs", bytes, { onSend: () => onSendCalls.push(1) });

    expect(onSendCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
  });

  test("inbound onReceive bytes are projected to host Uint8Array before forwarding", async () => {
    let capturedReceive: ((b: Uint8Array) => void) | undefined;
    const en = makeEn({
      registerDuplexHandler: async (channel, handler) => {
        capturedReceive = handler.onReceive;
        return { send: () => {}, unregisterHandler: () => {} };
      },
    });
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    const received: Uint8Array[] = [];
    bridge.registerHandler("pcs", { onReceive: (b) => received.push(b) });
    await new Promise((r) => setTimeout(r, 20));

    // Simulate inbound bytes from the standalone realm
    const incomingBytes = new Uint8Array([1, 2, 3]);
    capturedReceive!(incomingBytes);

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]!)).toEqual([1, 2, 3]);
  });

  test("unregisterHandler calls handle.unregisterHandler when handle is cached", async () => {
    const unregisterCalls: string[] = [];
    const en = makeEn({
      registerDuplexHandler: async (channel) => ({
        send: () => {},
        unregisterHandler: () => unregisterCalls.push(channel),
      }),
    });
    const realm = makeRealm(en);
    const sandbox = mockSandbox().withChatStore(chatStateFixture()).build();
    const bridge = createPresenceBridge(realm, sandbox);

    bridge.registerHandler("pcs", { onReceive: () => {} });
    await new Promise((r) => setTimeout(r, 20));

    bridge.unregisterHandler("pcs");
    expect(unregisterCalls).toContain("pcs");
  });
});
