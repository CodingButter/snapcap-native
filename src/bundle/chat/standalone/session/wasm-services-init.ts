/**
 * Initialize the WASM-side services (Platform, ConfigurationRegistry) the
 * f16f14e3 chunk would normally bring up from a worker bootstrap.
 *
 * Tasks the WASM submits to the platform queue run SYNCHRONOUSLY here —
 * the WASM uses the queue to dispatch the "deliver fetched messages to
 * the JS callback" work, and microtask-deferral has been observed to
 * cause callbacks to never fire (the WASM's internal expected-flow
 * synchronous Future → promise resolution gets confused).
 *
 * @internal
 */
import type { EmModule } from "./types.ts";

/**
 * Wire the Platform queue + reporters and stub out ConfigurationRegistry
 * with all-zero accessors. Both are no-ops on the WASM side beyond
 * letting init complete.
 */
export function initWasmServices(opts: {
  Module: EmModule;
  log: (line: string) => void;
  /** Standalone-realm Uint8Array — needed for getBinaryValue's empty default. */
  VmU8: Uint8ArrayConstructor;
}): void {
  const { Module, log, VmU8 } = opts;
  const Platform = (Module as Record<string, unknown>).shims_Platform as Record<
    string,
    Function
  >;
  const ConfigReg = (Module as Record<string, unknown>).config_ConfigurationRegistry as Record<
    string,
    Function
  >;

  // Run tasks SYNCHRONOUSLY when the WASM submits them. The WASM uses
  // the platform task queue to dispatch the "deliver fetched messages
  // to the JS callback" work — running it sync means callbacks fire on
  // the same JS turn that asked for them, so the WASM's internal
  // expected-flow (synchronous Future → promise resolution) doesn't
  // get confused by microtask reordering. Microtask-deferral has been
  // observed to cause callback callbacks to never fire.
  const runTask = (task: { run?: () => void } | (() => void), name: string): void => {
    try {
      let result: unknown;
      if (typeof task === "function") result = (task as () => unknown)();
      else if (task && typeof task.run === "function") result = task.run();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((err) =>
          log(`[queue.${name}] async throw ${(err as Error)?.message?.slice(0, 200)}`),
        );
      }
    } catch (err) {
      log(`[queue.${name}] throw ${(err as Error)?.stack?.slice(0, 200) ?? err}`);
    }
  };
  const platformQueue = {
    submit(task: { run?: () => void } | (() => void)) {
      runTask(task, "submit");
    },
    submitWithDelay(task: { run?: () => void } | (() => void), delay: bigint | number) {
      const ms = typeof delay === "bigint" ? Number(delay) : Number(delay);
      if (ms <= 0) {
        runTask(task, "submitWithDelay");
      } else {
        setTimeout(() => runTask(task, "submitWithDelay"), Math.min(ms, 60000));
      }
    },
    enqueue(task: { run?: () => void } | (() => void)) {
      runTask(task, "enqueue");
    },
    isCurrentQueueOrTrueOnAndroid: () => true,
    flushAndStop() {},
  };

  if (Platform && typeof Platform.init === "function") {
    Platform.init(
      { assertionMode: 2, minLogLevel: 2 },
      {
        logTimedEvent: () => {},
        log: (msg: unknown) =>
          log(
            `[wasm.log] ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 200)}`,
          ),
      },
    );
    Platform.registerSerialTaskQueue?.(platformQueue);
    Platform.installErrorReporter?.({
      reportError: (e: unknown) => log(`[wasm.error] ${JSON.stringify(e).slice(0, 200)}`),
    });
    Platform.installNonFatalReporter?.({
      reportError: (e: unknown) => log(`[wasm.nonfatal] ${JSON.stringify(e).slice(0, 200)}`),
    });
  }

  if (ConfigReg) {
    const makeConfig = () => ({
      getSystemType: () => 0,
      getRealValue: (_e: unknown) => 0,
      getIntegerValue: (_e: unknown) => 0n,
      getStringValue: (_e: unknown) => "",
      getBinaryValue: (_e: unknown) => new VmU8(0),
      getBooleanValue: (_e: unknown) => false,
      getConfigurationState: () => ({}),
    });
    for (const setter of [
      "setCircumstanceEngine",
      "setCompositeConfig",
      "setExperiments",
      "setServerConfig",
      "setTweaks",
      "setUserPrefs",
    ]) {
      try {
        ConfigReg[setter]?.(makeConfig());
      } catch {
        /* setter optional in some builds */
      }
    }
  }
}
