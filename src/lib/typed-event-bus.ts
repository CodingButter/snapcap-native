/**
 * Typed event bus — the shared subscription primitive every domain
 * manager (Friends, Messaging, Stories, Presence) composes.
 *
 * Built on the standard `EventTarget` so AbortSignal-based cleanup is
 * native — listeners auto-unsubscribe when the externally-passed
 * `opts.signal` aborts. Consumers never see `addEventListener`; the
 * public surface is `on(event, cb, opts?)` returning a {@link Subscription}.
 *
 * @example
 * ```ts
 * type MyEvents = { tick: (n: number) => void };
 * const bus = new TypedEventBus<MyEvents>();
 *
 * const sub = bus.on("tick", (n) => console.log(n));
 * bus.emit("tick", 1);   // logs 1
 * sub();                 // unsubscribe
 * bus.emit("tick", 2);   // no log
 * ```
 *
 * @typeParam TEvents - Event name → callback signature map. The keys
 * become the valid event names; the callback's argument type narrows
 * automatically on the event key passed to `on`.
 */
export class TypedEventBus<
  // We constrain `TEvents` only via the per-key indexing in `on` / `emit`
  // — not via `Record<string, …>` — because TS interfaces (the
  // recommended way to declare event maps) don't carry an implicit
  // string index signature, so `interface FriendsEvents { … }` fails to
  // satisfy `Record<string, …>`. The `& object` keeps it a concrete
  // record-shaped type without forcing the consumer to add `[k: string]: …`.
  TEvents extends object,
> {
  readonly #target = new EventTarget();

  /**
   * Subscribe to an event. Returns a {@link Subscription} — call to
   * unsubscribe, or use `.signal` to wire the subscription's lifetime
   * into anything that takes an `AbortSignal`.
   *
   * @param event - One of the keys of `TEvents`.
   * @param cb - Callback invoked with the event payload.
   * @param opts - Optional `signal`; aborting it tears down the subscription.
   */
  on<K extends keyof TEvents & string>(
    event: K,
    cb: TEvents[K],
    opts?: { signal?: AbortSignal },
  ): Subscription {
    const ctrl = new AbortController();

    // Wrap consumer cb in a CustomEvent unwrapper. detail carries the
    // single payload arg — keeping the public API one-payload-per-event
    // (no rest-args ceremony at the call site).
    //
    // Cast on `Parameters<…>`: TS can't prove `TEvents[K]` is callable
    // from the broad `TEvents extends object` constraint above; the
    // public surface (`cb: TEvents[K]`) still narrows correctly per
    // call site, the cast is just inside this internal handler.
    type Cb = (...args: any[]) => void;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as Parameters<TEvents[K] & Cb>[0];
      (cb as unknown as (arg: typeof detail) => void)(detail);
    };

    this.#target.addEventListener(event, handler, { signal: ctrl.signal });

    // External signal: when it aborts, our internal ctrl follows. Both
    // signals end up firing — sub.signal reflects the combined lifetime.
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }

    const off = (() => {
      if (!ctrl.signal.aborted) ctrl.abort();
    }) as Subscription;
    Object.defineProperty(off, "signal", { value: ctrl.signal, enumerable: true });
    return off;
  }

  /**
   * Emit an event. The single payload becomes the callback's argument.
   *
   * @internal Intended for the manager that owns this bus — composing
   * managers keep their bus instance private so consumers can't fake
   * events from outside.
   */
  emit<K extends keyof TEvents & string>(
    event: K,
    payload: Parameters<TEvents[K] & ((...args: any[]) => void)>[0],
  ): void {
    this.#target.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }
}

/**
 * A live subscription — callable thunk that tears down when invoked,
 * with `.signal` exposing the subscription's combined lifetime
 * (fires on `sub()` OR on an externally-passed `opts.signal` abort).
 */
export type Subscription = (() => void) & { signal: AbortSignal };
