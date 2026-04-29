/**
 * Messaging primitives + Conversation helper.
 *
 * Three gRPC methods on `messagingcoreservice.MessagingCoreService`:
 *   - SendTypingNotification    — show "typing…" indicator to recipient
 *   - UpdateConversation        — change view state (entered/active/left)
 *   - UpdateContentMessage      — mark message viewed / read
 *
 * The bundle ships descriptors for these in lazy-loaded chunks we don't
 * pre-fetch, so we hand-encode the request bodies via ProtoWriter and
 * synthesize GrpcMethodDesc objects on the fly. Wire shapes were lifted
 * from real captured traffic (see SnapAutomate/recon-bin/).
 */
import { ProtoWriter, ProtoReader, uuidToBytes, bytesToUuid } from "../transport/proto-encode.ts";
import type { GrpcMethodDesc } from "../transport/grpc-web.ts";
import { User } from "./user.ts";

const SERVICE = { serviceName: "messagingcoreservice.MessagingCoreService" };

/**
 * TypingActivityType enum value sent in SendTypingNotification.
 * Captured wire value 6 corresponds to active TEXT typing in real traffic.
 * Other values exist (voice recording, etc.) but aren't surfaced yet.
 */
export const TypingActivity = {
  TEXT: 6,
} as const;

/**
 * UpdateConversation viewState enum value. Captured traffic shows two
 * values used during normal chat interaction:
 *   9  — entering / focusing the conversation
 *   10 — actively viewing
 * Naming is best-guess; tighten when more recon lands.
 */
export const ConversationViewState = {
  ENTERED: 9,
  ACTIVE: 10,
} as const;

// ── Method descriptors ────────────────────────────────────────────────

export type SendTypingNotificationRequest = {
  conversationId: string;
  userId: string;
  typingType?: number; // defaults to TypingActivity.TEXT
};

export const SendTypingNotificationDesc: GrpcMethodDesc<SendTypingNotificationRequest, Record<string, unknown>> = {
  methodName: "SendTypingNotification",
  service: SERVICE,
  requestType: {
    serializeBinary(this: SendTypingNotificationRequest): Uint8Array {
      // wire shape: { 1: { 1: bytes(16) senderUserId }, 2: { 1: bytes(16) conversationId }, 3: int32 typingType }
      // Confirmed by cross-referencing captured bytes against SyncConversations IDs.
      const w = new ProtoWriter();
      w.fieldMessage(1, (inner) => inner.fieldBytes(1, uuidToBytes(this.userId)));
      w.fieldMessage(2, (inner) => inner.fieldBytes(1, uuidToBytes(this.conversationId)));
      w.fieldVarint(3, this.typingType ?? TypingActivity.TEXT);
      return w.finish();
    },
  },
  responseType: {
    decode: (_b: Uint8Array): Record<string, unknown> => ({}),
  },
};

export type UpdateConversationRequest = {
  conversationId: string;
  userId: string;
  viewState: number; // see ConversationViewState
  /** Unix ms; defaults to now. Server uses this as the action timestamp. */
  timestampMs?: number;
};

export const UpdateConversationDesc: GrpcMethodDesc<UpdateConversationRequest, Record<string, unknown>> = {
  methodName: "UpdateConversation",
  service: SERVICE,
  requestType: {
    serializeBinary(this: UpdateConversationRequest): Uint8Array {
      // wire shape from recon:
      //   { 1: { 1: { 1: bytes16 conversationId },  2: varint timestamp_ms,  3: varint=22 },
      //     2: { 1: { 1: bytes16 senderUserId },    2: { 2: varint viewState } } }
      const ts = this.timestampMs ?? Date.now();
      const w = new ProtoWriter();
      w.fieldMessage(1, (c) => {
        c.fieldMessage(1, (id) => id.fieldBytes(1, uuidToBytes(this.conversationId)));
        c.fieldVarint(2, ts);
        c.fieldVarint(3, 0x16);
      });
      w.fieldMessage(2, (u) => {
        u.fieldMessage(1, (uid) => uid.fieldBytes(1, uuidToBytes(this.userId)));
        u.fieldMessage(2, (state) => state.fieldVarint(2, this.viewState));
      });
      return w.finish();
    },
  },
  responseType: {
    decode: (_b: Uint8Array): Record<string, unknown> => ({}),
  },
};

export type UpdateContentMessageRequest = {
  messageId: bigint;
  conversationId: string;
  userId: string;
  /** Action enum — 15 in capture (mark-viewed?). */
  action: number;
};

export const UpdateContentMessageDesc: GrpcMethodDesc<UpdateContentMessageRequest, Record<string, unknown>> = {
  methodName: "UpdateContentMessage",
  service: SERVICE,
  requestType: {
    serializeBinary(this: UpdateContentMessageRequest): Uint8Array {
      // wire shape from recon:
      //   { 1: int64 messageId, 2: int32 action,
      //     3: { 1: { 1: bytes16 senderUserId }, 2: int32=6, 3: { 1: bytes16 conversationId } },
      //     6: { ... optional content payload, omitted } }
      const w = new ProtoWriter();
      w.fieldVarint(1, this.messageId);
      w.fieldVarint(2, this.action);
      w.fieldMessage(3, (m) => {
        m.fieldMessage(1, (u) => u.fieldBytes(1, uuidToBytes(this.userId)));
        m.fieldVarint(2, 6);
        m.fieldMessage(3, (c) => c.fieldBytes(1, uuidToBytes(this.conversationId)));
      });
      return w.finish();
    },
  },
  responseType: {
    decode: (_b: Uint8Array): Record<string, unknown> => ({}),
  },
};

// ── High-level helpers ────────────────────────────────────────────────

export type Rpc = {
  unary: (
    method: GrpcMethodDesc<unknown, unknown>,
    request: unknown,
  ) => Promise<unknown>;
};

export async function sendTypingNotification(
  rpc: Rpc,
  conversationId: string,
  userId: string,
  typingType: number = TypingActivity.TEXT,
): Promise<void> {
  await rpc.unary(
    SendTypingNotificationDesc as unknown as GrpcMethodDesc<unknown, unknown>,
    { conversationId, userId, typingType } satisfies SendTypingNotificationRequest,
  );
}

export async function updateConversationView(
  rpc: Rpc,
  conversationId: string,
  userId: string,
  viewState: number,
): Promise<void> {
  await rpc.unary(
    UpdateConversationDesc as unknown as GrpcMethodDesc<unknown, unknown>,
    { conversationId, userId, viewState } satisfies UpdateConversationRequest,
  );
}

export async function markMessageViewed(
  rpc: Rpc,
  messageId: bigint,
  conversationId: string,
  userId: string,
  action: number = 15,
): Promise<void> {
  await rpc.unary(
    UpdateContentMessageDesc as unknown as GrpcMethodDesc<unknown, unknown>,
    { messageId, conversationId, userId, action } satisfies UpdateContentMessageRequest,
  );
}

// ── CreateContentMessage (text DM) ──

export type SendTextRequest = {
  senderUserId: string;
  conversationId: string;
  text: string;
  /** Optional override; defaults to a random int64 (timestamp-based). */
  messageId?: bigint;
  /** Optional override; defaults to a random UUID (idempotency token). */
  clientMessageId?: string;
};

const CREATE_CONTENT_MESSAGE_TEXT_DESC: GrpcMethodDesc<SendTextRequest, Record<string, unknown>> = {
  methodName: "CreateContentMessage",
  service: SERVICE,
  requestType: {
    serializeBinary(this: SendTextRequest): Uint8Array {
      // wire shape (text DM, derived from captured bytes):
      //   { 1: { 1: bytes16 senderUserId },
      //     2: int64 messageId,
      //     3: { 1: { 1: { 1: bytes16 conversationId }, 2: int32=8 } },
      //     4: { 2: int32=1, 4: { 2: { 1: string text } }, 7: int32=2 },
      //     8: { 1: { 1: bytes16 clientMessageId } } }
      const w = new ProtoWriter();
      w.fieldMessage(1, (u) => u.fieldBytes(1, uuidToBytes(this.senderUserId)));
      w.fieldVarint(2, this.messageId ?? randomInt64());
      w.fieldMessage(3, (dest) => {
        dest.fieldMessage(1, (inner) => {
          inner.fieldMessage(1, (cid) => cid.fieldBytes(1, uuidToBytes(this.conversationId)));
          inner.fieldVarint(2, 8);
        });
      });
      w.fieldMessage(4, (content) => {
        content.fieldVarint(2, 1);
        content.fieldMessage(4, (textWrapper) => {
          textWrapper.fieldMessage(2, (body) => body.fieldString(1, this.text));
        });
        content.fieldVarint(7, 2);
      });
      w.fieldMessage(8, (cm) => {
        cm.fieldMessage(1, (id) =>
          id.fieldBytes(1, uuidToBytes(this.clientMessageId ?? crypto.randomUUID())),
        );
      });
      return w.finish();
    },
  },
  responseType: {
    decode: (_b: Uint8Array): Record<string, unknown> => ({}),
  },
};

/** Generate a positive int64 message ID (timestamp-derived + random low bits). */
function randomInt64(): bigint {
  const high = BigInt(Date.now()) << 16n;
  const low = BigInt(Math.floor(Math.random() * 0xffff));
  return high | low;
}

export async function sendText(
  rpc: Rpc,
  senderUserId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  await rpc.unary(
    CREATE_CONTENT_MESSAGE_TEXT_DESC as unknown as GrpcMethodDesc<unknown, unknown>,
    { senderUserId, conversationId, text } satisfies SendTextRequest,
  );
}

// ── SyncConversations: list conversations the logged-in user is in ──

export type SyncConversationsRequest = {
  selfUserId: string;
  /** Snap pins a protocol-version string here. Default ("useV4") matches captured traffic. */
  protocol?: string;
};

const SYNC_CONVERSATIONS_DESC: GrpcMethodDesc<SyncConversationsRequest, RawConversation[]> = {
  methodName: "SyncConversations",
  service: SERVICE,
  requestType: {
    serializeBinary(this: SyncConversationsRequest): Uint8Array {
      // wire shape: { 1: { 1: bytes16 self }, 2: string protocol, 4: {}, 5: bool }
      const w = new ProtoWriter();
      w.fieldMessage(1, (u) => u.fieldBytes(1, uuidToBytes(this.selfUserId)));
      w.fieldString(2, this.protocol ?? "useV4");
      w.fieldMessage(4, () => {});
      w.fieldVarint(5, 1);
      return w.finish();
    },
  },
  responseType: {
    decode: parseSyncConversationsResponse,
  },
};

/** Raw conversation data extracted from the SyncConversations response. */
export type RawConversation = {
  conversationId: string;
  participantUserIds: string[];
  /** Snap's `field 10.1` — observed value 2 for DMs. */
  kindCode: number;
  /** Last-activity timestamp (ms epoch). */
  lastActivityMs: number;
};

function parseSyncConversationsResponse(buf: Uint8Array): RawConversation[] {
  const out: RawConversation[] = [];
  const r = new ProtoReader(buf);
  while (r.hasMore()) {
    const tag = r.next();
    if (!tag) break;
    if (tag.field === 1 && tag.wireType === 2) {
      out.push(parseConversationEntry(r.message()));
    } else {
      r.skip(tag.wireType);
    }
  }
  return out;
}

function parseConversationEntry(r: ProtoReader): RawConversation {
  let conversationId = "";
  const participants: string[] = [];
  let kindCode = 0;
  let lastActivityMs = 0;
  while (r.hasMore()) {
    const tag = r.next();
    if (!tag) break;
    if (tag.field === 1 && tag.wireType === 2) {
      // field 1 = conversation identity wrapper { 1: { 1: bytes16 } }
      const inner = r.message();
      while (inner.hasMore()) {
        const t = inner.next();
        if (!t) break;
        if (t.field === 1 && t.wireType === 2) {
          const inner2 = inner.message();
          while (inner2.hasMore()) {
            const t2 = inner2.next();
            if (!t2) break;
            if (t2.field === 1 && t2.wireType === 2) {
              conversationId = bytesToUuid(inner2.bytes());
            } else inner2.skip(t2.wireType);
          }
        } else inner.skip(t.wireType);
      }
    } else if (tag.field === 3 && tag.wireType === 0) {
      lastActivityMs = Number(r.varint());
    } else if (tag.field === 7 && tag.wireType === 2) {
      // repeated participant: { 1: bytes16 userId }
      const inner = r.message();
      while (inner.hasMore()) {
        const t = inner.next();
        if (!t) break;
        if (t.field === 1 && t.wireType === 2) {
          participants.push(bytesToUuid(inner.bytes()));
        } else inner.skip(t.wireType);
      }
    } else if (tag.field === 10 && tag.wireType === 2) {
      const inner = r.message();
      while (inner.hasMore()) {
        const t = inner.next();
        if (!t) break;
        if (t.field === 1 && t.wireType === 0) {
          kindCode = Number(inner.varint());
        } else inner.skip(t.wireType);
      }
    } else {
      r.skip(tag.wireType);
    }
  }
  return { conversationId, participantUserIds: participants, kindCode, lastActivityMs };
}

export async function syncConversations(rpc: Rpc, selfUserId: string): Promise<RawConversation[]> {
  return (await rpc.unary(
    SYNC_CONVERSATIONS_DESC as unknown as GrpcMethodDesc<unknown, unknown>,
    { selfUserId } satisfies SyncConversationsRequest,
  )) as RawConversation[];
}

// ── Conversation class — domain object with QoL methods ──

/**
 * Subset of SnapcapClient that Conversation needs. Defined here (not
 * imported from client.ts) to avoid a circular module dependency. Any
 * real SnapcapClient instance satisfies this implicitly.
 */
export type ConversationOwner = {
  rpc: Rpc;
  self?: User;
};

export type ConversationKind = "dm" | "group" | "myStory" | "unknown";

/**
 * A live chat handle. Wraps the participant + identity context so call
 * sites can use ergonomic methods (`chat.setTyping(2000)`,
 * `chat.typeAndSendText(...)`) without re-passing IDs.
 *
 * Constructed by `client.getConversations()` or `client.conversation()`.
 * Holds a back-reference to the owning client so methods can call into
 * the lower-level primitives.
 */
export class Conversation {
  public readonly conversationId: string;
  public readonly participants: User[];
  public readonly kind: ConversationKind;
  public readonly lastActivityAt: Date | undefined;

  constructor(
    private readonly owner: ConversationOwner,
    data: {
      conversationId: string;
      participants: User[];
      kind?: ConversationKind;
      lastActivityAt?: Date;
    },
  ) {
    this.conversationId = data.conversationId;
    this.participants = data.participants;
    this.kind = data.kind ?? "unknown";
    this.lastActivityAt = data.lastActivityAt;
  }

  /**
   * The other participant in a DM. Undefined for groups, my-story, or
   * before the owning client has resolved its self-user.
   */
  get friend(): User | undefined {
    if (this.kind !== "dm") return undefined;
    if (!this.owner.self) return undefined;
    return this.participants.find((p) => p.userId !== this.owner.self!.userId);
  }

  // ── primitives ─────────────────────────────────────────────────────

  /**
   * Send "typing…" notification.
   *
   * Without `durationMs`: a single pulse. Snap's UI auto-clears in ~5s.
   *
   * With `durationMs`: refreshes the pulse every 3s for the duration,
   * then stops (the indicator naturally times out shortly after).
   * Useful when composing a longer message and you want the indicator
   * to stay visible the whole time.
   */
  async setTyping(durationMs?: number): Promise<void> {
    this.requireSelf();
    if (durationMs === undefined || durationMs <= 0) {
      await sendTypingNotification(
        this.owner.rpc,
        this.conversationId,
        this.owner.self!.userId,
      );
      return;
    }
    const start = Date.now();
    while (Date.now() - start < durationMs) {
      await sendTypingNotification(
        this.owner.rpc,
        this.conversationId,
        this.owner.self!.userId,
      );
      const remaining = durationMs - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(3000, remaining)));
    }
  }

  /** Mark the conversation as actively viewed (recipient sees a read indicator). */
  async markViewed(state: number = ConversationViewState.ACTIVE): Promise<void> {
    this.requireSelf();
    await updateConversationView(
      this.owner.rpc,
      this.conversationId,
      this.owner.self!.userId,
      state,
    );
  }

  /** Mark a single received message as viewed. */
  async markMessageViewed(messageId: bigint, action: number = 15): Promise<void> {
    this.requireSelf();
    await markMessageViewed(
      this.owner.rpc,
      messageId,
      this.conversationId,
      this.owner.self!.userId,
      action,
    );
  }

  // ── quality-of-life ────────────────────────────────────────────────

  /** Send a text message into this conversation. */
  async sendText(message: string): Promise<void> {
    this.requireSelf();
    await sendText(this.owner.rpc, this.owner.self!.userId, this.conversationId, message);
  }

  /**
   * Type for `durationMs` ms then send the message. Mimics a human
   * composing a message in the UI: the recipient sees the typing
   * indicator, then sees the message.
   */
  async typeAndSendText(durationMs: number, message: string): Promise<void> {
    await this.setTyping(durationMs);
    return this.sendText(message);
  }

  // ── internal ───────────────────────────────────────────────────────

  private requireSelf(): void {
    if (!this.owner.self) {
      throw new Error(
        "Conversation requires the owning client's self user to be resolved. " +
        "Either log in via SnapcapClient.fromCredentials() or set client.self manually before calling Conversation methods.",
      );
    }
  }
}
