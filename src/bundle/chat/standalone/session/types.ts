/**
 * Session bring-up types.
 *
 * `SetupBundleSessionOpts` is the only option-bag the SDK passes from
 * `api/messaging/bringup.ts` into the standalone realm — it carries the
 * SSO bearer, cookie jar, user identity, and the per-message + per-session
 * callbacks the consumer wants fired as the WASM produces plaintext.
 *
 * @internal
 */
import type { CookieJar } from "tough-cookie";
import type { StandaloneChatRealm } from "../types.ts";

/**
 * Plaintext message handed to the consumer's `onPlaintext` callback.
 *
 * `content` is the decrypted bytes the WASM produced for `t.content`
 * inside the messagingDelegate. For text DMs it's a UTF-8 string of the
 * sent text. For media messages it's a small protobuf header pointing
 * at the encrypted CDN blob.
 */
export type PlaintextMessage = {
  /** Decrypted message bytes the WASM produced. */
  content: Uint8Array;
  /** True iff WE are the sender (outbound); false for inbound from peer. */
  isSender: boolean | undefined;
  /** Snap's contentType enum (2 = text, 3 = media, …). */
  contentType: number | undefined;
  /** Raw delegate object for advanced callers — keys vary by build. */
  raw: Record<string, unknown>;
};

/**
 * Options for `setupBundleSession`.
 */
export type SetupBundleSessionOpts = {
  /** Standalone-WASM payload from `getStandaloneChatRealm()`. */
  realm: StandaloneChatRealm;
  /** Active SSO bearer (Zustand `auth.authToken.token`). */
  bearer: string;
  /**
   * Cookie jar used for WS-upgrade and gRPC requests. Tough-cookie's
   * shared jar from `getOrCreateJar(dataStore)`.
   */
  cookieJar: CookieJar;
  /**
   * UA string the Snap web client uses; passed to WS upgrade headers
   * and gRPC requests.
   */
  userAgent: string;
  /**
   * Our Snap userId as a UUID string (`"527be2ff-aaec-4622-9c68-…"`).
   * Used to build `clientCfg.userId` and the session's
   * `getAuthContextDelegate.getAuthContext`.
   */
  userId: string;
  /**
   * Conversation IDs (UUID strings) to enter + pull message history
   * for after the session bootstraps. Empty = wait passively for
   * live frames only.
   */
  conversationIds?: readonly string[];
  /**
   * Called every time the wrapped messaging delegate produces a
   * plaintext message. May fire many times per session.
   */
  onPlaintext: (msg: PlaintextMessage) => void;
  /**
   * Called once, after `En.createMessagingSession(...)` resolves, with
   * the bundle-realm session object. Consumers (e.g. `Messaging.sendText`)
   * hold the reference to drive outbound `sendMessageWithContent` calls
   * via the session's `getConversationManager()` / `getSnapManager()`.
   *
   * Optional — leave unset if the caller only wants inbound decrypt.
   */
  onSession?: (session: BundleMessagingSession) => void;
  /** Called for diagnostic events. Defaults to `process.stderr.write`. */
  log?: (line: string) => void;
  /**
   * Override path to the Snap bundle dir (the one containing
   * `cf-st.sc-cdn.net/dw/`). Defaults to the SDK's `vendor/snap-bundle`.
   */
  bundleDir?: string;
  /**
   * Optional DataStore for cross-run persistence of the bundle's
   * `userDataStore` slots (`e2eeIdentityKey`, `e2eeTempKey`). Without
   * persistence the WASM mints a FRESH Fidelius identity every run,
   * which:
   *   1) Re-registers via InitializeWebKey (cheap but wasteful)
   *   2) Loses the ability to decrypt messages encrypted to OUR
   *      previous public key — those messages report
   *      `decrypt_failure: "CEK_ENTRY_NOT_FOUND"` and the WASM hands
   *      the messagingDelegate an analytics struct with empty content.
   * Pass the same DataStore the SDK uses for its cookie jar to keep
   * the identity stable across script restarts.
   */
  dataStore?: {
    get(k: string): Promise<Uint8Array | undefined>;
    set(k: string, v: Uint8Array): Promise<void>;
    delete(k: string): Promise<void>;
    keys?: (prefix?: string) => string[];
  };
};

/**
 * Tear-down handle returned by `setupBundleSession`. Currently a no-op
 * disposer (the bundle's session lives for the process lifetime once
 * started); reserved for future explicit teardown.
 */
export type BundleSessionDisposer = () => void;

/**
 * The bundle-realm WASM messaging session — Embind-bound, methods include
 * `getConversationManager()`, `getSnapManager()`, `getFeedManager()`,
 * `reachabilityChanged(b)`, `appStateChanged(state)`, etc.
 *
 * Surfaced via {@link SetupBundleSessionOpts.onSession} so outbound send
 * methods on `Messaging` can drive `sendMessageWithContent` directly.
 */
export type BundleMessagingSession = Record<string, Function>;

/**
 * Embind Module shape we need handles on (for `_malloc` / `_free` /
 * `HEAPU8` when writing arg-buffers across the JS↔WASM boundary).
 *
 * @internal
 */
export type EmModule = {
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  HEAPU8: Uint8Array;
  abort?: (what?: unknown) => void;
  [k: string]: unknown;
};
