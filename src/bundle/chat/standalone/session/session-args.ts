/**
 * Build the 18-slot argument array `En.createMessagingSession(...)`
 * expects, plus the persistent + ephemeral storage adapters that wrap
 * `opts.dataStore` (when provided) for the WASM's identity / RWK keys.
 *
 * Slot positions (recovered from the bundle's chunk source) are
 * load-bearing — comments below mirror the bundle's local var names
 * (`e`, `t`, `r`, ..., `g`, `y`, `h`) so future bundle-remap work can
 * find them.
 *
 * Without `dataStore`, every run mints a FRESH Fidelius identity — any
 * messages encrypted to OUR previous public key fail to decrypt with
 * `CEK_ENTRY_NOT_FOUND`. The slot-2 `e2eeKeyPersistence` returning
 * `requestReEncryptionForMessage: () => true` is the safety net that
 * gets the EEL re-init handshake going for unrecoverable CEKs.
 *
 * @internal
 */
import type { SetupBundleSessionOpts } from "./types.ts";
import { uuidToBytes16 } from "./id-coercion.ts";
import { bigintReplacer } from "./utils.ts";

/**
 * Construct the 18-arg session-create payload.
 *
 * @internal
 */
export function buildSessionArgs(opts: {
  setupOpts: SetupBundleSessionOpts;
  /** Standalone-realm Uint8Array — used everywhere bytes cross the realm boundary. */
  VmU8: Uint8ArrayConstructor;
  /** Standalone-realm Map ctor — for the tweaks dictionary. */
  VmMap: MapConstructor;
  log: (line: string) => void;
}): unknown[] {
  const { setupOpts, VmU8, VmMap, log } = opts;
  const userIdBytes = uuidToBytes16(setupOpts.userId, VmU8);

  const clientCfg = {
    databaseLocation: ":memory:",
    userId: { id: userIdBytes },
    userAgentPrefix: "",
    debug: false,
    tweaks: { tweaks: new VmMap<number, string>() },
  };

  const sessionDelegate = {
    onConnectionStateChanged: (_s: unknown) => {},
    getAuthContextDelegate: () => ({
      getAuthContext: async (cb: { onSuccess?: Function; onError?: Function }) => {
        try {
          cb?.onSuccess?.({ authToken: setupOpts.bearer, userId: { id: userIdBytes } });
        } catch (e) {
          cb?.onError?.(e);
        }
      },
    }),
    onDataWipe: () => {},
    onError: (e: unknown) =>
      log(`[sessionDelegate.onError] ${JSON.stringify(e).slice(0, 200)}`),
  };

  // E2EEKeyPersistence — slot 2 of Sess.create. The bundle's own stub
  // returns `false` for persistKey/remove/requestReEncryption — meaning
  // "I don't persist keys, I don't request re-encryption". We do the
  // same for persist/remove (the WASM has its own in-memory store) but
  // RETURN TRUE for requestReEncryptionForMessage so the WASM kicks
  // off an EEL re-init handshake when it can't find a CEK for an
  // inbound message. That handshake mints a fresh CEK and the message
  // becomes decryptable on the next pass — recovering decryption for
  // messages that arrived against a previous identity (which is exactly
  // our pre-existing inbox state on first run).
  const e2eeKeyPersistence = {
    persistKeyForMessage: (_a: unknown, _b: unknown, _c: unknown) => true,
    removeKeyForMessage: (_a: unknown, _b: unknown) => true,
    // CRITICAL — returning `true` here triggers an EEL re-init handshake
    // when the WASM can't find a CEK for an inbound message. Without
    // this, pre-existing messages encrypted to a stale identity report
    // CEK_ENTRY_NOT_FOUND and the messagingDelegate sees empty content.
    requestReEncryptionForMessage: (_a: unknown, _b: unknown, _c: unknown) => true,
    storeUserWrappedIdentityKeys: (_e: unknown) => {},
    loadUserWrappedIdentityKeys: async () => [],
  };

  const mediaUploadDelegate = {
    uploadMedia: (_e: unknown, _t: unknown, _r: unknown) => {},
    uploadMediaReferences: (_e: unknown, _t: unknown) => {},
  };

  const snapchatterInfoDelegate = {
    fetchSnapchatterInfos: async (_e: unknown) =>
      Promise.reject(new Error("Not implemented")),
    fetchFriendLink: (_t: unknown, _r: unknown) => {},
  };

  // Slot 6 (analyticsLogger) — the bundle calls this on every WASM-side
  // event (RECEIVE_MESSAGE, decrypt_failure, …). We swallow them; throwing
  // here propagates back into the messaging path and is caught by our
  // try/catch around the wrapped delegate, but the spam isn't useful.
  const analyticsLogger = (_ev: unknown): void => {};

  // pr()-compatible storage adapters. Backed by `opts.dataStore` when
  // provided so the WASM's persisted identity keys survive script
  // restarts — without persistence, the WASM mints a fresh Fidelius
  // identity each run and any messages encrypted to our PREVIOUS
  // public key fail to decrypt with `CEK_ENTRY_NOT_FOUND`.
  // Canonical UDS slot path uses `local_` prefix (composed with slot
  // names like `uds.e2eeIdentityKey.shared` → `local_uds.e2eeIdentityKey.shared`).
  // An earlier version used `local_uds_` which produced the duplicate
  // `local_uds_uds.e2eeIdentityKey.shared` key alongside the canonical one.
  const UDS_PREFIX = "local_";
  const td = new TextDecoder();
  const te = new TextEncoder();
  const ds = setupOpts.dataStore;
  const inMemFallback = new Map<string, Map<string, string>>();
  const inMemUds = (label: string) => {
    void label;
    if (!inMemFallback.has(label)) inMemFallback.set(label, new Map());
    const memStore = inMemFallback.get(label)!;
    return {
      async getItem(k: string) {
        if (ds) {
          try {
            const bytes = await ds.get(UDS_PREFIX + k);
            return bytes ? td.decode(bytes) : undefined;
          } catch {
            /* fall through to mem */
          }
        }
        return memStore.get(k);
      },
      async setItem(k: string, v: string) {
        const s = typeof v === "string" ? v : String(v);
        memStore.set(k, s);
        if (ds) {
          try {
            await ds.set(UDS_PREFIX + k, te.encode(s));
          } catch {
            /* tolerate */
          }
        }
      },
      async removeItem(k: string) {
        memStore.delete(k);
        if (ds) {
          try {
            await ds.delete(UDS_PREFIX + k);
          } catch {
            /* tolerate */
          }
        }
      },
      async keys() {
        if (ds && typeof ds.keys === "function") {
          const all = ds.keys(UDS_PREFIX) ?? [];
          return all.map((k) => k.slice(UDS_PREFIX.length));
        }
        return Array.from(memStore.keys());
      },
    };
  };

  // Slot 10 (`l`) is the **friend keys cache fallback** — the WASM's
  // `getKeysForUserAsync` calls `o(userId)` (where `o` is inner async
  // arg #5 = outer slot 10) when its in-WASM cache misses. It expects a
  // Promise resolving to the friend's wrapped public keys, OR a falsy
  // value to trigger the syncFriendKeys gRPC fallback. We return
  // undefined — the WASM then calls syncFriendKeys via the GrpcManager
  // factory, which fetches from the Fidelius gateway and caches the
  // result. Without this being a function, fresh inbound messages from
  // any sender whose keys aren't already cached fail to decrypt with
  // `o is not a function` and the WS push pipeline goes silent.
  const friendKeysCacheLookup = async (_userId: unknown): Promise<undefined> => undefined;
  // Slot 15 (`g`) becomes inner async arg #8 (`c`) which is used in
  // `ht(e) === ht(c) ? "current" : "friend"` — the current user identity
  // for differentiating self vs friend in metric dimensions.
  const currentUserIdentity = { id: userIdBytes };

  return [
    /* 0 e */ clientCfg,
    /* 1 t */ sessionDelegate,
    /* 2 r */ e2eeKeyPersistence,
    /* 3 n */ mediaUploadDelegate,
    /* 4 s */ {},
    /* 5 a */ snapchatterInfoDelegate,
    /* 6 i */ analyticsLogger,
    /* 7 c */ buildRwkStorage(ds, td, te, log),
    /* 8 u */ inMemUds("e2eeIdentityKey"),
    /* 9 m */ inMemUds("e2eeTempKey"),
    /* 10 l */ friendKeysCacheLookup,
    /* 11 d */ async () => {
      // loadUserWrappedIdentityKeys — returns the cached identity key
      // list. The bundle's `pr()` storage (slots 8 + 9) tracks these
      // under `uds.e2eeIdentityKey.shared` (a JSON-encoded array). Read
      // it back here so the bundle skips the InitializeWebKey re-mint
      // path on startup.
      if (!ds) return [];
      try {
        const bytes = await ds.get(UDS_PREFIX + "uds.e2eeIdentityKey.shared");
        if (!bytes) return [];
        const arr = JSON.parse(td.decode(bytes));
        return Array.isArray(arr) ? arr : [];
      } catch (e) {
        log(`[loadUserWrappedIdentityKeys] err ${(e as Error).message?.slice(0, 100)}`);
        return [];
      }
    },
    /* 12 _ */ {},
    /* 13 f */ {},
    /* 14 p */ { id: userIdBytes },
    /* 15 g */ currentUserIdentity,
    /* 16 y */ {},
    /* 17 h */ {},
  ];
}

/**
 * Slot-7 RWK (root wrapping key) storage. Persist through DataStore so
 * the Fidelius rwk survives across runs and pre-existing CEKs remain
 * unwrappable.
 */
function buildRwkStorage(
  ds: SetupBundleSessionOpts["dataStore"],
  td: TextDecoder,
  te: TextEncoder,
  log: (line: string) => void,
) {
  const RWK_KEY = "local_rwk_blob";
  return {
    async get() {
      if (ds) {
        const bytes = await ds.get(RWK_KEY);
        if (bytes) {
          const s = td.decode(bytes);
          try {
            return JSON.parse(s);
          } catch {
            return s;
          }
        }
      }
      return undefined;
    },
    async set(v: unknown) {
      if (ds) {
        try {
          const s = typeof v === "string" ? v : JSON.stringify(v, bigintReplacer);
          await ds.set(RWK_KEY, te.encode(s));
        } catch (e) {
          log(`[rwk.set] err ${(e as Error).message?.slice(0, 100)}`);
        }
      }
    },
    async purge() {
      // Intentionally a no-op (logged): the WASM calls purge() as a
      // best-effort hint to rotate the wrapping key, but our SDK
      // persists across runs — losing the RWK forces a re-mint and
      // resets the entire identity (every cached CEK becomes
      // unwrappable). We tolerate the rotation hint by ignoring it;
      // the WASM regenerates the in-memory RWK on next session boot
      // from the persisted blob.
      log("[rwk.purge.skipped]");
    },
  };
}
