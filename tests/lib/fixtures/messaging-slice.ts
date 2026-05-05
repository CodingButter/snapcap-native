/**
 * Fixture builders for the chat-bundle `state.messaging` slice.
 *
 * Covers conversation-cache topologies the SDK reads:
 *   - empty (cold start)
 *   - one-conv (single 1:1 with a participant set)
 *   - many-conv (10 conversations, mix of 1:1 and group)
 *
 * Every export is a function — fresh objects per call.
 *
 * Pair with {@link mockSandbox} from `../mock-sandbox.ts`.
 */
import type { MessagingSlice } from "../../../src/bundle/types/index.ts";

/**
 * Default empty messaging slice — no conversations cached, fetch is a no-op.
 *
 * @param overrides - shape to merge.
 */
export function messagingSliceFixture(
  overrides: Partial<MessagingSlice> = {},
): MessagingSlice {
  return {
    conversations: {},
    fetchConversation: async () => undefined,
    ...overrides,
  };
}

/**
 * Build a single conversation cache entry. Returns the structural shape
 * the bundle stores in `state.messaging.conversations[convId]`.
 *
 * @param participants - hyphenated UUID strings of participants
 * @returns A conversation cache entry (typed as `unknown` per the bundle).
 */
export function conversationFixture(participants: string[]): unknown {
  return {
    participants: participants.map((str) => ({ id: new Uint8Array(16), str })),
    type: participants.length === 2 ? "ONE_ON_ONE" : "GROUP",
  };
}

/**
 * One-conversation messaging slice — one 1:1 between `selfId` and `peerId`.
 *
 * @param convId - hyphenated conv UUID
 * @param selfId - hyphenated UUID of the logged-in user
 * @param peerId - hyphenated UUID of the other participant
 * @param overrides - shape to merge.
 */
export function oneConvMessagingSliceFixture(
  convId: string,
  selfId: string,
  peerId: string,
  overrides: Partial<MessagingSlice> = {},
): MessagingSlice {
  return messagingSliceFixture({
    conversations: {
      [convId]: conversationFixture([selfId, peerId]),
    },
    ...overrides,
  });
}

/**
 * Many-conversation messaging slice — N convs (default 10), mix of 1:1 and
 * group. All convs include `selfId` as a participant. Useful for testing
 * `messaging/reads.ts` `listConversations`.
 *
 * @param selfId - hyphenated UUID of the logged-in user (always a participant)
 * @param count - how many conversations to seed (default 10)
 * @param overrides - shape to merge.
 */
export function manyConvMessagingSliceFixture(
  selfId: string,
  count = 10,
  overrides: Partial<MessagingSlice> = {},
): MessagingSlice {
  const conversations: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const convId = `${String(i).padStart(8, "0")}-cccc-cccc-cccc-cccccccccccc`;
    const peerId = `${String(i).padStart(8, "0")}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    // Every 4th conv = group; else 1:1.
    const participants = i % 4 === 3
      ? [selfId, peerId, `${String(i).padStart(8, "0")}-bbbb-bbbb-bbbb-bbbbbbbbbbbb`]
      : [selfId, peerId];
    conversations[convId] = conversationFixture(participants);
  }
  return messagingSliceFixture({
    conversations,
    ...overrides,
  });
}
