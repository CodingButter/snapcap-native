/**
 * Standalone chat realm — manages a SECOND WASM instance of Snap's chat
 * bundle in an isolated `vm.Context`, used for both Fidelius identity
 * mint and the messaging session.
 *
 * # WHY a second WASM instance (technical debt)
 *
 * The bundle's main top-level eval auto-boots a chat WASM into the main
 * Sandbox realm. That instance lives in a realm where the Worker shim is
 * neutered (so messaging session bring-up doesn't loop in metrics +
 * sentry traffic), and the noop'd worker bridge corrupts internal state
 * such that the static Embind call
 * `e2ee_E2EEKeyManager.generateKeyInitializationRequest` aborts.
 *
 * Sidestep: boot a SECOND WASM in a fresh vm.Context (this dir's
 * `realm.ts`) which has clean Embind state, and run the messaging
 * session there too (`session/setup.ts`).
 *
 * **Cost:** ~12 MB extra memory + ~250 ms boot time per `SnapcapClient`.
 * Negligible at low N; bites at multi-tenancy scales (N > 20 per process).
 *
 * **Fix path** (NOT done): reverse-engineer Snap's expected worker init
 * sequence so the main-realm WASM doesn't get corrupted. Estimate:
 * 1-2 weeks of bundle introspection + worker-shim rewrite. Worth it
 * if multi-tenancy ever matters.
 *
 * @see https://github.com/CodingButter/snapcap-native/issues — file an
 * issue for the de-duplication work if it becomes a priority.
 */
export { getStandaloneChatRealm, getStandaloneChatModule } from "./realm.ts";
export { mintFideliusIdentity } from "./identity-mint.ts";
export type {
  KeyManagerStatics,
  StandaloneChatRealm,
  StandaloneChatModule,
  StandaloneChatWreq,
} from "./types.ts";
export {
  setupBundleSession,
  type PlaintextMessage,
  type SetupBundleSessionOpts,
  type BundleSessionDisposer,
  type BundleMessagingSession,
} from "./session/index.ts";
