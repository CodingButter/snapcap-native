/**
 * STATE-DRIVEN tests — `src/bundle/worker-proxy-facade.ts`.
 *
 * `makeWorkerProxyFacade` builds a Proxy-wrapped facade. Tests cover:
 *   - createMessagingSession → forwards to moduleEnv.messaging_Session.create
 *   - setUserData → stashes, doesn't throw
 *   - stop → resolves without throw
 *   - onNetworkStatusChange → no-throw
 *   - unknown method access → throws "not implemented in facade"
 *   - `then` property → undefined (not thenable)
 *   - symbol reads → no throw
 */
import { describe, expect, test } from "bun:test";
import { makeWorkerProxyFacade } from "../../src/bundle/worker-proxy-facade.ts";

describe("bundle/worker-proxy-facade — makeWorkerProxyFacade", () => {
  test("createMessagingSession forwards to messaging_Session.create", async () => {
    const fakeSession = { id: "session-1" };
    const moduleEnv = {
      messaging_Session: {
        create: async (...args: unknown[]) => fakeSession,
      },
    };

    const facade = makeWorkerProxyFacade(moduleEnv);
    const result = await facade.createMessagingSession("arg1", "arg2");
    expect(result).toBe(fakeSession);
  });

  test("createMessagingSession throws descriptively when messaging_Session.create is missing", async () => {
    const facade = makeWorkerProxyFacade({});
    await expect(facade.createMessagingSession()).rejects.toThrow(
      "workerProxy.createMessagingSession",
    );
  });

  test("createMessagingSession wraps errors from create", async () => {
    const moduleEnv = {
      messaging_Session: {
        create: async () => { throw new Error("inner error"); },
      },
    };
    const facade = makeWorkerProxyFacade(moduleEnv);
    await expect(facade.createMessagingSession()).rejects.toThrow("inner error");
  });

  test("setUserData stashes data without throwing", () => {
    const facade = makeWorkerProxyFacade({});
    expect(() => facade.setUserData("user-123", { token: "abc" })).not.toThrow();
  });

  test("stop resolves without throw", async () => {
    const facade = makeWorkerProxyFacade({});
    const result = await facade.stop();
    expect(result).toBeUndefined();
  });

  test("onNetworkStatusChange does not throw for known statuses", () => {
    const facade = makeWorkerProxyFacade({});
    expect(() => facade.onNetworkStatusChange("BROWSER_ONLINE")).not.toThrow();
    expect(() => facade.onNetworkStatusChange("BROWSER_OFFLINE")).not.toThrow();
  });

  test("unknown method access throws 'not implemented in facade'", () => {
    const facade = makeWorkerProxyFacade({});
    const unknownFn = (facade as Record<string, unknown>)["unknownMethod"] as (...a: unknown[]) => never;
    expect(typeof unknownFn).toBe("function");
    expect(() => unknownFn("arg1", 42)).toThrow("not implemented in facade");
  });

  test("unknown method error message includes the method name", () => {
    const facade = makeWorkerProxyFacade({});
    const fn = (facade as Record<string, unknown>)["customMethod"] as (...a: unknown[]) => never;
    expect(() => fn()).toThrow("workerProxy.customMethod");
  });

  test("`then` property returns undefined so facade is not thenable", () => {
    const facade = makeWorkerProxyFacade({});
    expect((facade as { then?: unknown }).then).toBeUndefined();
  });

  test("symbol reads don't throw (e.g. Symbol.toPrimitive)", () => {
    const facade = makeWorkerProxyFacade({});
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _ = (facade as unknown as Record<symbol, unknown>)[Symbol.toPrimitive];
    }).not.toThrow();
  });
});
