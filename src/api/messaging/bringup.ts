/**
 * Lazy session bring-up — boots the standalone chat WASM (mints
 * Fidelius identity if needed), grabs the realm, then calls
 * `setupBundleSession` and wires its `onPlaintext` callback into the
 * per-instance event bus's `message` channel.
 *
 * Conversation IDs are enumerated via `listConversations` so the WASM
 * has every conv pre-entered for live delivery + history pumps.
 *
 * Single-flight: `ensureSession` caches the in-flight bring-up
 * Promise on the per-instance internal so concurrent callers share
 * one bring-up.
 *
 * @internal
 */
import { setupBundleSession } from "../../auth/fidelius-decrypt.ts";
import {
  mintFideliusIdentity,
  getStandaloneChatRealm,
} from "../../auth/fidelius-mint.ts";
import { getOrCreateJar } from "../../shims/cookie-jar.ts";
import type { MessagingInternal, Cell } from "./internal.ts";
import { listConversations } from "./reads.ts";

/**
 * Boot the standalone chat WASM (mints Fidelius identity if needed),
 * grab the realm, then call `setupBundleSession` — wiring its
 * `onPlaintext` callback into our `events.emit("message", ...)`.
 *
 * Conversation IDs are enumerated via `listConversations` so the WASM
 * has every conv pre-entered for live delivery + history pumps.
 *
 * @internal
 */
export async function bringUpSession(internal: MessagingInternal): Promise<void> {
  const ctx = await internal.ctx();
  const sandbox = ctx.sandbox;

  // Mint identity (warm-path: no-op if already cached) + grab realm.
  await mintFideliusIdentity(sandbox);
  const realm = await getStandaloneChatRealm(sandbox);
  internal.realm.set(realm);

  // Pull bearer + self userId from the auth slice. The slice's userId
  // lands via Zustand setState during `auth.initialize`, which can race
  // with our microtask timing — poll briefly with a short backoff
  // before throwing so consumers don't hit a transient miss when they
  // chain `.on()` directly off `await authenticate()`.
  const { authSlice } = await import("../../bundle/register.ts");
  const auth = await import("../auth.ts");
  let userId: string | undefined;
  let bearer: string | undefined;
  // Poll up to 30s for the bundle's auth slice to populate `userId`. On
  // warm-path auth this is sub-second; on cold-fresh auth (no cookies,
  // no cached identity) the bundle's React-effect chain that lands
  // `state.auth.userId` can take 10-25s because it depends on multiple
  // async fetches. For BEARER, we have a separate SDK-side getter
  // (`getAuthToken`) that resolves immediately once authBundle()
  // returns — use it as a fast-path.
  bearer = auth.getAuthToken(ctx) || undefined;

  // Kick the bundle to populate `state.auth.userId` (on cold-fresh
  // auth, the field isn't set until `fetchUserData` runs — which the
  // bundle's React layer normally calls on page mount but we don't run).
  try {
    const slice0 = authSlice(sandbox) as Record<string, unknown>;
    const fetchUserData = slice0.fetchUserData as ((source?: string) => unknown) | undefined;
    if (typeof fetchUserData === "function") {
      // Best-effort fire — return value may be a Promise we don't need
      // to await; the side-effect is the slice update.
      const r = fetchUserData("messaging_session_bringup");
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).catch(() => {});
      }
    }
  } catch { /* tolerate */ }

  for (let i = 0; i < 300; i++) {
    const slice = authSlice(sandbox) as {
      userId?: string;
      me?: { userId?: string } | string;
      authToken?: { token?: string };
    };
    // Try several known userId locations on the slice. The cold-fresh
    // auth slice has only `me` + the action methods until fetchUserData
    // runs; warm-path runs have `userId` directly.
    const meAny = slice.me as { userId?: string } | string | undefined;
    userId =
      slice.userId ??
      (typeof meAny === "object" ? meAny?.userId : undefined) ??
      (typeof meAny === "string" ? meAny : undefined);
    bearer = slice.authToken?.token || bearer;
    if (userId && userId.length >= 32 && bearer) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!userId || userId.length < 32) {
    throw new Error(
      "Messaging.bringUpSession: chat-bundle auth slice has no userId after 30s — auth.initialize may not have completed; verify client.authenticate() resolved cleanly",
    );
  }
  if (!bearer) {
    throw new Error(
      "Messaging.bringUpSession: no bearer in auth slice or via getAuthToken — call client.authenticate() first",
    );
  }

  const cookieJar = getOrCreateJar(ctx.dataStore);

  // Enumerate convs so the bundle's WASM gets every conv pre-entered;
  // best-effort — empty list still works (live frames only, no
  // history pump).
  let convIds: string[] = [];
  try {
    const convs = await listConversations(ctx, userId);
    convIds = convs.map((c) => c.conversationId);
  } catch {
    /* fall through with empty list */
  }

  // TODO: typing/viewing/read inbound slots — Sess.create's slot 9 is
  // the messagingDelegate (onMessageReceived/onMessagesReceived,
  // wired below). The presence delegate lives on a sibling slot; once
  // identified, hook it here and emit `typing`/`viewing`/`read`.
  await setupBundleSession({
    realm,
    bearer,
    cookieJar,
    userAgent: ctx.userAgent,
    userId,
    conversationIds: convIds,
    dataStore: ctx.dataStore,
    onPlaintext: (msg) => {
      internal.events.emit("message", msg);
    },
    onSession: (session) => {
      internal.session.set(session);
    },
  });
}

/**
 * Single-flight bring-up gate. Cached on a `Cell<Promise|undefined>`
 * owned by the `Messaging` class so multiple calls share one bring-up
 * and a failure resets the cell so a future call can retry.
 *
 * @internal
 */
export function ensureSession(
  internal: MessagingInternal,
  promiseCell: Cell<Promise<void> | undefined>,
): Promise<void> {
  if (!promiseCell.value) {
    promiseCell.value = bringUpSession(internal).catch((e) => {
      // Reset so a future subscription can retry.
      promiseCell.value = undefined;
      throw e;
    });
  }
  return promiseCell.value;
}
