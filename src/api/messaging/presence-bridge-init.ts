/**
 * Lazy presence-bridge initialization + per-conv presence-session
 * cache.
 *
 * Modern Snap clients gate the typing / viewing indicators on the
 * presence layer (`state.presence.presenceSession`); this module owns
 * the once-per-instance bridge install and the per-conv
 * `createPresenceSession` round-trip.
 *
 * Splits out of `presence-out.ts` to keep the dual-path setTyping /
 * setViewing flow readable while the bridge dance and messaging-slice
 * seeding live alongside their explanatory comments.
 *
 * @internal
 */
import { uuidToBytes } from "../_helpers.ts";
import { createPresenceBridge } from "../../bundle/presence-bridge.ts";
import type { BundlePresenceSession } from "../../bundle/types.ts";
import type { MessagingInternal } from "./internal.ts";
import { listConversations, getSelfUserId } from "./reads.ts";

/**
 * Ensure the bundle's presence layer has a live `presenceSession` for
 * `convId`. Lazily initializes
 * `state.presence.initializePresenceServiceTs(bridge)` on first call,
 * then creates (or reuses) a per-conv presence session.
 *
 * The bundle's `state.presence.presenceSession` is single-slot, so a
 * `createPresenceSession(B)` after a `createPresenceSession(A)` will
 * dispose A's session and replace it. Our cache is correct only as
 * long as we don't interleave convs; the cache check + state read
 * below verifies the slot still matches our cached session before
 * returning it.
 *
 * Returns `undefined` when the realm / session bring-up hasn't
 * happened yet (caller should fall back to convMgr-only path) — same
 * defensive posture as the existing setTyping / setViewing methods.
 *
 * @internal
 */
export async function ensurePresenceForConv(
  internal: MessagingInternal,
  convId: string,
): Promise<BundlePresenceSession | undefined> {
  process.stderr.write(`[trace.presence] ensurePresenceForConv ENTER convId=${convId.slice(0, 8)} presenceInitialized=${internal.presenceInitialized.value}\n`);
  const realm = internal.realm.get();
  if (!realm) {
    process.stderr.write(`[trace.presence] ensurePresenceForConv EXIT no realm\n`);
    return undefined;
  }
  const ctx = await internal.ctx();
  const sandbox = ctx.sandbox;
  const { presenceSlice } = await import("../../bundle/register.ts");

  // First-call init. Wrapped in its own try so a failure here doesn't
  // permanently block the cache — a future call retries.
  if (!internal.presenceInitialized.value) {
    try {
      process.stderr.write(`[trace.presence] ensurePresenceForConv → initializePresenceServiceTs(bridge)\n`);
      const slice = presenceSlice(sandbox);
      const bridge = createPresenceBridge(realm, sandbox, (line) => {
        // Always echo presence-bridge log lines under our trace tag so
        // we don't have to set SNAPCAP_DEBUG_PRESENCE for the run.
        process.stderr.write(`[trace.bridge.log] ${line}\n`);
      });
      slice.initializePresenceServiceTs(bridge);
      internal.presenceInitialized.value = true;
      process.stderr.write(`[trace.presence] ensurePresenceForConv ← initializePresenceServiceTs ok\n`);
    } catch (e) {
      process.stderr.write(`[trace.presence] ensurePresenceForConv ← initializePresenceServiceTs THREW=${(e as Error).message?.slice(0, 200)}\n`);
      // Surface the bundle's exact error for diagnostic clarity (e.g.
      // "Local user ID is not set" if auth slice hasn't populated).
      if (process.env.SNAPCAP_DEBUG_PRESENCE) {
        process.stderr.write(
          `[messaging.ensurePresenceForConv] initializePresenceServiceTs threw: ${
            (e as Error).message?.slice(0, 200)
          }\n`,
        );
      }
      return undefined;
    }
  }

  // Cache hit — verify the bundle still has our session in its slot.
  const cached = internal.presenceSessions.get(convId);
  if (cached) {
    try {
      const slice = presenceSlice(sandbox);
      if (slice.presenceSession === cached) {
        process.stderr.write(`[trace.presence] ensurePresenceForConv CACHE-HIT slot-still-matches\n`);
        return cached;
      }
    } catch { /* fall through to recreate */ }
    // Stale (replaced by a different conv's session, or disposed) —
    // drop and recreate below.
    process.stderr.write(`[trace.presence] ensurePresenceForConv CACHE-STALE recreating\n`);
    internal.presenceSessions.delete(convId);
  }

  // Create fresh session. The slice action returns a cleanup thunk we
  // intentionally discard — `presenceSession.dispose()` is the proper
  // teardown path (same end-effect, but the slot bookkeeping is what
  // we actually want when switching convs).
  //
  // The slice expects an envelope `{id: Uint8Array(16), str: convIdStr}`
  // (NOT a bare string) — module 74918's `s.QA(envelope)` returns the
  // `.str` field, and a bare-string input would fall through to the
  // fallback path inside `d()` and crash with `e[t+0]` because string
  // values have no `.id`. Build the envelope with a CHAT-realm
  // Uint8Array so the bundle's `u(e)` check (`id instanceof Uint8Array`)
  // against the chat realm constructor succeeds.
  try {
    const slice = presenceSlice(sandbox);
    const ChatU8 = sandbox.getGlobal<Uint8ArrayConstructor>("Uint8Array") ?? Uint8Array;
    const idBytes = new ChatU8(16);
    idBytes.set(uuidToBytes(convId));
    const convEnvelope = { id: idBytes, str: convId };

    await seedMessagingConversation(internal, convId, convEnvelope, ChatU8);

    process.stderr.write(`[trace.presence] ensurePresenceForConv → createPresenceSession({id-bytelen=${idBytes.byteLength}, str=${convId.slice(0, 8)}})\n`);
    slice.createPresenceSession(convEnvelope);
    // The slice populates `state.presence.presenceSession` AFTER an
    // async await on `n.createPresenceSession(...)` resolves; poll
    // briefly. Real cost is bounded — the inner await only blocks on
    // an `observeConversationParticipants` first-value pull.
    //
    // `candidate.conversationId` is the envelope ({id, str}) we passed
    // in — compare via `.str`. Note: the bundle may also receive
    // `firstValueFrom(participants$)` that NEVER emits if the conv
    // isn't in `state.messaging.conversations` (the slice's
    // observeConversationParticipants logs a warn and emits nothing).
    // The 1s poll budget below is a soft cap — if no session lands,
    // we proceed without one and fall back to the convMgr-only path.
    let session: BundlePresenceSession | undefined;
    for (let i = 0; i < 50; i++) {
      const candidate = presenceSlice(sandbox).presenceSession;
      if (candidate && candidate.conversationId?.str === convId) {
        session = candidate;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    if (session) {
      internal.presenceSessions.set(convId, session);
      process.stderr.write(`[trace.presence] ensurePresenceForConv ← createPresenceSession LANDED session-obj for conv=${convId.slice(0, 8)}\n`);
      return session;
    }
    process.stderr.write(`[trace.presence] ensurePresenceForConv ← createPresenceSession POLL-EXHAUSTED no session in slot after 1s\n`);
  } catch (e) {
    process.stderr.write(`[trace.presence] ensurePresenceForConv ← createPresenceSession THREW=${(e as Error).message?.slice(0, 200)}\n`);
  }
  return undefined;
}

/**
 * Seed `state.messaging.conversations[convId]` BEFORE calling
 * `createPresenceSession`. The slice's `createPresenceSession` ends up
 * `await firstValueFrom(observeConversationParticipants$)` inside
 * `PresenceServiceImpl`; that observable only emits when the conv is
 * in `state.messaging.conversations` (selector `mt.VN(state,
 * convIdStr)` reads `state.messaging.conversations[convIdStr]
 * ?.participants`). Without React running the bundle's normal
 * feed-pump, the slice is empty, the observable never emits, and
 * `createPresenceSession` hangs forever — the 1s poll above times out
 * and returns `undefined`, killing the entire modern-presence path.
 *
 * The slice's own `fetchConversation` action would do this, but it
 * routes through `Sr(state)` which throws "Expected the messaging
 * client to be set" — the bundle's React layer populates
 * `state.messaging.client` via `initializeClient`, and that path
 * depends on `state.wasm.workerProxy` (a Comlink-wrapped Web Worker
 * we don't run). Playing the React role: write a minimal
 * `{participants: [{participantId: envelope}, ...]}` record DIRECTLY
 * into the slice via `chatStore.setState`. The selector only reads
 * `.participants[].participantId`; that's the contract the presence
 * observable needs and the only contract we owe it.
 *
 * Participant envelopes are built from the SDK's already-resolved
 * self userId + conversation participant list. Skips when the conv is
 * already in the slice (e.g. priming on a hot path) so we don't
 * clobber a richer record the bundle's own action wrote.
 *
 * @internal
 */
async function seedMessagingConversation(
  internal: MessagingInternal,
  convId: string,
  convEnvelope: { id: Uint8Array; str: string },
  ChatU8: Uint8ArrayConstructor,
): Promise<void> {
  try {
    const ctx = await internal.ctx();
    const { chatStore } = await import("../../bundle/register.ts");
    const store = chatStore(ctx.sandbox);
    const state = store.getState() as {
      messaging?: { conversations?: Record<string, unknown> };
    };
    const conversations = state.messaging?.conversations;
    const alreadySeeded = !!(conversations && conversations[convId]);
    process.stderr.write(`[trace.presence] ensurePresenceForConv slice-conversations.has(${convId.slice(0, 8)})=${alreadySeeded}\n`);
    if (alreadySeeded) return;
    // Build the envelope shape `{id: ChatU8(16), str}` for each
    // participant — same wrapper the bundle uses (module 74918's
    // `c(uuid)` factory), but we synthesize directly so the seed
    // doesn't depend on reaching into another bundle module.
    const selfUserId = await getSelfUserId(ctx);
    let participantUuids: string[] = [selfUserId];
    try {
      const all = await listConversations(ctx, selfUserId);
      const found = all.find((c) => c.conversationId === convId);
      if (found && found.participants.length) {
        participantUuids = found.participants;
      }
    } catch {
      // Best-effort — fall back to self-only. The selector still
      // emits (with one participant), unblocking the observable.
    }
    const buildEnv = (uuid: string): { id: Uint8Array; str: string } => {
      const b = new ChatU8(16);
      b.set(uuidToBytes(uuid));
      return { id: b, str: uuid };
    };
    const participants = participantUuids.map((u) => ({
      participantId: buildEnv(u),
    }));
    process.stderr.write(`[trace.presence] ensurePresenceForConv → setState messaging.conversations[${convId.slice(0, 8)}]={participants:${participants.length}}\n`);
    store.setState((s) => {
      const ms = (s as { messaging?: { conversations?: Record<string, unknown> } }).messaging;
      if (!ms) return s;
      // Direct mutation is the bundle's pattern — Zustand uses
      // Immer drafts internally for the messaging slice, so
      // mutating the draft + returning the same state object lands
      // the change. (See `(0,fr.wD)(r, e.messaging.conversations)`
      // in the bundle's slice — it mutates the conversations
      // object in place.)
      const conv = ms.conversations ?? (ms.conversations = {});
      conv[convId] = {
        conversation: { conversationId: convEnvelope, participants },
        participants,
        messages: new Map(),
        hasMoreMessages: false,
        isActive: false,
        loadingMessages: false,
      };
      return s;
    });
    process.stderr.write(`[trace.presence] ensurePresenceForConv ← setState ok\n`);
  } catch (e) {
    process.stderr.write(`[trace.presence] ensurePresenceForConv messaging-slice seed THREW=${(e as Error).message?.slice(0, 200)}\n`);
  }
}
