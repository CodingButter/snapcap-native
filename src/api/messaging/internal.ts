/**
 * Internal accessor surface used by sibling files (`send.ts`,
 * `presence-out.ts`, `bringup.ts`, etc.) to read + mutate per-instance
 * state owned by the `Messaging` class without forcing module-scope
 * mutable state.
 *
 * The `Messaging` class constructs ONE of these per instance and hands
 * it to the free-function helpers; each helper closes over its own
 * `MessagingInternal` and never sees other instances' state. Per-
 * instance isolation by construction (per
 * `feedback_no_module_scope_state.md`).
 *
 * Mutable scalars are exposed as `{ value: T }` boxes so the helpers
 * can write through (`internal.presenceInitialized.value = true`) while
 * the underlying field still lives on the class. Mutable references to
 * objects (the `BundleMessagingSession`, the `StandaloneChatRealm`) are
 * exposed as a `set(...)` setter + a `get()` getter for the same
 * reason.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";
import type { TypedEventBus } from "../../lib/typed-event-bus.ts";
import type { BundleMessagingSession } from "../../auth/fidelius-decrypt.ts";
import type { StandaloneChatRealm } from "../../auth/fidelius-mint.ts";
import type { BundlePresenceSession } from "../../bundle/types.ts";
import type { MessagingEvents } from "./interface.ts";

/**
 * Boxed mutable cell. Lets sibling files write back to a class field
 * without dragging the field's owner into module scope.
 */
export interface Cell<T> {
  value: T;
}

/**
 * Read+write handle to a class field that holds an optional reference
 * (e.g. the bundle messaging session that gets set during bring-up).
 */
export interface Slot<T> {
  get(): T | undefined;
  set(v: T | undefined): void;
}

/**
 * The shape sibling files import from. The `Messaging` class builds it
 * inside its constructor and passes it down to every free function.
 *
 * @internal
 */
export interface MessagingInternal {
  /** Resolves the per-instance `ClientContext` (auth, sandbox, dataStore). */
  ctx: () => Promise<ClientContext>;
  /** Per-instance event bus for `message` / `typing` / `viewing` / `read`. */
  events: TypedEventBus<MessagingEvents>;
  /** Single-flight bring-up gate; see `bringup.ts#ensureSession`. */
  ensureSession: () => Promise<void>;
  /** Read+write slot for the bundle messaging session. */
  session: Slot<BundleMessagingSession>;
  /** Read+write slot for the standalone-chat realm. */
  realm: Slot<StandaloneChatRealm>;
  /** Once-per-instance "have we initialized presence?" flag. */
  presenceInitialized: Cell<boolean>;
  /** Per-conv presence session cache. Keyed by convId string. */
  presenceSessions: Map<string, BundlePresenceSession>;
}
