/**
 * Thin facade exposing the methods Snap's bundle calls on
 * `state.wasm.workerProxy` — bridges our directly-booted Module to
 * the bundle's Web-Worker-shaped contract.
 *
 * The bundle normally constructs `workerProxy` by Comlink-wrapping
 * a real Web Worker that hosts the WASM. We don't have Web Workers
 * in vm.Context, so we boot the WASM directly (see
 * `chat-wasm-boot.ts`) and build a facade that exposes the same
 * method names. When the bundle's `messaging.initializeClient` runs,
 * it constructs all 18 args itself and calls
 * `workerProxy.createMessagingSession(...args)` — our facade forwards
 * those to `moduleEnv.messaging_Session.create(...args)`.
 *
 * Contract (verified by grep against the chat bundle):
 *
 *   - `createMessagingSession(...18 args)` — Embind handles, forwarded to
 *     `moduleEnv.messaging_Session.create(...)`.
 *   - `setUserData(userId, userData)` — store-action; no-op + stash.
 *   - `stop()` — beforeunload teardown; no-op for now.
 *   - `onNetworkStatusChange("BROWSER_ONLINE" | "BROWSER_OFFLINE")` — no-op.
 *   - Comlink `releaseProxy` symbol — module-private symbol identity,
 *     not addressable from us; left unwired (will throw clearly if hit
 *     during teardown, which we don't care about until a real session
 *     works).
 *
 * Unknown method calls land on a Proxy `get` trap that returns a
 * function which logs the call name + args and throws with a
 * descriptive "not implemented in facade" error — surfaces missed
 * contract methods immediately as runtime errors with names.
 *
 * @internal Bundle-layer plumbing. Public consumers never construct this.
 */

/**
 * The (intentionally minimal) shape the bundle calls on
 * `state.wasm.workerProxy`. Not exhaustive — the Proxy trap catches
 * anything we missed and throws so we know what to add.
 *
 * @internal
 */
export interface WorkerProxyFacade {
  createMessagingSession(...args: unknown[]): Promise<unknown>;
  setUserData(userId: unknown, userData: unknown): void;
  stop(): Promise<void>;
  onNetworkStatusChange(status: string): void;
  /** Allow the Proxy to expose any other method name lazily. */
  [key: string]: unknown;
}

/**
 * Build a facade that satisfies the bundle's Comlink-wrapped-worker
 * contract by forwarding into the directly-booted Emscripten module.
 *
 * @internal
 * @param moduleEnv - the Emscripten `moduleEnv` returned by
 *   {@link bootChatWasm}. Carries the registered Embind classes
 *   (`messaging_Session`, etc.).
 * @returns a facade that the bundle can store as `state.wasm.workerProxy`.
 */
export function makeWorkerProxyFacade(
  moduleEnv: Record<string, unknown>,
): WorkerProxyFacade {
  // Stash for setUserData payloads — the bundle's wasm slice may read
  // these back later; for now we just hold them so we can inspect.
  const userDataStash: Map<unknown, unknown> = new Map();

  const target: WorkerProxyFacade = {
    /**
     * Forward the bundle's 18-arg session construction into the
     * Embind class on our directly-booted module.
     *
     * The bundle's `messaging.initializeClient` builds all 18
     * positional args (Embind handles for delegates, factories, Cof
     * config, etc.) and calls this. We just relay.
     */
    async createMessagingSession(...args: unknown[]): Promise<unknown> {
      const klass = moduleEnv.messaging_Session as
        | { create?: (...a: unknown[]) => unknown }
        | undefined;
      if (!klass || typeof klass.create !== "function") {
        throw new Error(
          "workerProxy.createMessagingSession: moduleEnv.messaging_Session.create is not a function — " +
            "WASM didn't register the Embind class (boot ordering bug?)",
        );
      }
      try {
        return await klass.create(...args);
      } catch (err) {
        throw new Error(
          `workerProxy.createMessagingSession: messaging_Session.create threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },

    /**
     * Store-action mirror: bundle calls this from
     * `wasm.setUserData(userId, userData)`. We stash for inspection;
     * no behavioral side-effect required for session bring-up.
     */
    setUserData(userId: unknown, userData: unknown): void {
      userDataStash.set(userId, userData);
      console.log(
        "[snapcap] workerProxy.setUserData called (stashed):",
        typeof userId === "string" ? userId : "(non-string id)",
      );
    },

    /**
     * beforeunload teardown — best-effort no-op. We don't have a
     * worker to terminate; the Embind module dies with the sandbox.
     */
    async stop(): Promise<void> {
      console.log("[snapcap] workerProxy.stop called (no-op)");
    },

    /**
     * Window online/offline event mirror — informational only.
     */
    onNetworkStatusChange(status: string): void {
      console.log("[snapcap] workerProxy.onNetworkStatusChange:", status);
    },
  };

  // Wrap in a Proxy so that unknown-method calls surface as descriptive
  // runtime errors rather than silent `undefined is not a function`.
  // We allow-list a few legitimate property reads (`then`, symbol keys,
  // toJSON, inspect hooks) so the facade behaves sanely when introspected.
  return new Proxy(target, {
    get(t, prop, receiver) {
      // Symbol reads (e.g. Comlink.releaseProxy, util.inspect.custom,
      // Symbol.toPrimitive, Symbol.asyncIterator). Returning `undefined`
      // is the harmless default for unknown symbols; `then` is critical
      // (Promise resolvers probe `.then` on returned values).
      if (typeof prop === "symbol") {
        return Reflect.get(t, prop, receiver);
      }
      if (prop === "then") {
        // Important: don't let the facade look thenable or `await
        // workerProxy` will hang forever.
        return undefined;
      }
      const existing = Reflect.get(t, prop, receiver);
      if (existing !== undefined) return existing;

      // Unknown method — return a function that logs + throws so we
      // see exactly what missing contract piece the bundle hit.
      return (...args: unknown[]): never => {
        const argShape = args
          .map((a) => (a === null ? "null" : typeof a))
          .join(", ");
        throw new Error(
          `workerProxy.${String(prop)} not implemented in facade ` +
            `(called with ${args.length} arg(s): [${argShape}]) — ` +
            `add a forwarder in src/bundle/worker-proxy-facade.ts`,
        );
      };
    },
  });
}
