/**
 * Messaging — public barrel.
 *
 * Tier-2 api feature directory: composes the `Messaging` class
 * (`./manager.ts`) with stateless free-function helpers in sibling
 * files. Consumers import from this barrel — they never need to know
 * whether the directory has 1 file or 14.
 *
 * Architecture:
 *
 *   - `manager.ts` owns the per-instance class shell + private
 *     fields (`#events`, `#session`, `#realm`, presence cache, …).
 *   - Each public method on the class is a one-line trampoline into
 *     a sibling free function (`./send.ts`, `./presence-out.ts`,
 *     `./set-typing.ts`, `./reads.ts`, `./bringup.ts`, …) that
 *     receives a per-instance `MessagingInternal` accessor.
 *   - The accessor (`./internal.ts`) exposes the class's mutable
 *     state via boxed `Cell<T>` / `Slot<T>` handles so siblings can
 *     read + write through without taking module-scope mutable state
 *     (per `feedback_no_module_scope_state.md`).
 *   - Inbound wire-format parsers live in `./parse/` —
 *     `parseSyncConversations`, `parseBatchDeltaSync`, the inline
 *     `ProtoReader`, plus the envelope plaintext / UUID extractors.
 *
 * Public surface re-exported below — one re-export per consumer-facing
 * symbol; sibling files referenced lazily by sibling code.
 *
 * @internal
 */
export { Messaging } from "./manager.ts";
export type { MessagingEvents } from "./interface.ts";
export type { ConversationSummary, RawEncryptedMessage } from "./types.ts";
