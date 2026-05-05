/**
 * Post-auth Fidelius identity bring-up.
 *
 * After `auth.initialize` populates the auth slice with a bearer, mint
 * a fresh Fidelius identity from the chat-bundle WASM and register it
 * with Snap's `FideliusIdentityService.InitializeWebKey`. On success
 * (or on the "already-registered" 401), persist the wrapped-identity
 * envelope into the DataStore at `local_uds.e2eeIdentityKey.shared` so
 * the bundle's warm-path can read it on subsequent boots.
 *
 * @internal
 */
import { authSlice } from "../../bundle/register/index.ts";
import { getOrCreateJar } from "../../shims/cookie-jar.ts";
import { mintFideliusIdentity } from "../../bundle/chat/standalone/index.ts";
import { initializeWebKey, type FideliusIdentity } from "../fidelius.ts";
import type { ClientContext } from "../_context.ts";
import type { AuthSliceLive } from "./types.ts";

/** DataStore key for the bundle's UDS `e2eeIdentityKey` slot (shared). */
const UDS_E2EE_IDENTITY_KEY = "local_uds.e2eeIdentityKey.shared";

/**
 * After `auth.initialize` populates the auth slice with a bearer, mint a
 * fresh Fidelius identity from the chat-bundle WASM and register it with
 * Snap's `FideliusIdentityService.InitializeWebKey`. On success (or on
 * the "already-registered" 401 — see below) we persist a wrapped-identity
 * envelope into the DataStore at `local_uds.e2eeIdentityKey.shared` so
 * the bundle's warm-path can read it on subsequent boots.
 *
 * Replaces the previous bundle-driven `messaging.initializeClient` path:
 * the bundle's own session bring-up doesn't actually drive Fidelius
 * registration in our (worker-less) realm, so we drive it directly via
 * the same WASM Embind class the worker would have called.
 *
 * Idempotent: subsequent calls hit the warm-path cache (the persisted
 * UDS slot) and skip both the WASM mint and the gRPC round-trip.
 *
 * Failure here is non-fatal — friends / search / DMs / stories all work
 * without a registered Fidelius identity; only E2E ops require it.
 *
 * @internal
 */
export async function kickoffMessagingSession(ctx: ClientContext): Promise<void> {
  // Warm-path: identity already cached in the DataStore — nothing to do.
  const cached = await ctx.dataStore.get(UDS_E2EE_IDENTITY_KEY);
  if (cached && cached.byteLength > 0) {
    return;
  }

  // Cold-path: mint a fresh Fidelius identity in a clean vm.Context
  // (separate from the bundle's auto-instantiated noop'd Module — see
  // `bundle/chat/standalone/realm.ts` for the rationale) and POST it to Snap's
  // `FideliusIdentityService.InitializeWebKey`. On 200 we persist the
  // SERVER's response bytes (the canonical wrapped-identity payload)
  // into the DataStore at `local_uds.e2eeIdentityKey.shared`.
  //
  // Failures here propagate. There's no placeholder fallback: a
  // placeholder UDS slot would let downstream E2E ops silently produce
  // garbage (encrypt against zeros, read garbage on decrypt). Better to
  // surface the bring-up failure loudly than to ship a bad identity.
  const identity: FideliusIdentity = await mintFideliusIdentity(ctx.sandbox);

  const bearer = (authSlice(ctx.sandbox) as unknown as AuthSliceLive).authToken.token;
  if (!bearer) {
    throw new Error("kickoffMessagingSession: no bearer in auth slice — Fidelius register requires a populated authToken");
  }

  const sharedJar = getOrCreateJar(ctx.dataStore);
  const cookieHeader = (await sharedJar.getCookies("https://web.snapchat.com"))
    .map((c) => `${c.key}=${c.value}`)
    .join("; ");

  const outcome = await initializeWebKey(identity, {
    bearer,
    cookieHeader: cookieHeader || undefined,
    userAgent: ctx.userAgent,
  });

  if (outcome.kind === "ok") {
    // Persist the wrapped identity in the JSON shape the bundle's UDS
    // WrappedIdentityKeys decoder expects:
    //   `[{ data: <base64>, lastUpdatedTimestamp: <ms> }]`
    // The raw response bytes ARE the canonical wrapped form — Snap's
    // server registration confirms this byte sequence; the bundle's
    // warm-path reader decodes it on next boot.
    const blob = JSON.stringify([
      {
        data: bytesToBase64(outcome.response.raw),
        lastUpdatedTimestamp: Date.now(),
      },
    ]);
    await ctx.dataStore.set(UDS_E2EE_IDENTITY_KEY, new TextEncoder().encode(blob));
    return;
  }

  if (outcome.kind === "already-registered") {
    // Account already has a server-side identity from another session.
    // We legitimately can't mint a new one — surface to the operator
    // (a full web logout + re-login mints a fresh identity); do NOT
    // persist any placeholder bytes (would let downstream E2E ops
    // produce garbage against an unknown server-side identity).
    console.warn(
      `[snapcap] Fidelius InitializeWebKey returned 401 already-registered (status=${outcome.status}); ` +
      `account has an existing identity from another session. ` +
      `Log out fully via web.snapchat.com and re-authenticate to mint a fresh identity.`,
    );
    return;
  }

  throw new Error(
    `Fidelius InitializeWebKey failed (status=${outcome.status}): ${outcome.bodyText.slice(0, 200)}`,
  );
}

/** Standard Buffer-free base64 encoder for byte payloads stored in the UDS slot. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return Buffer.from(bin, "binary").toString("base64");
}
