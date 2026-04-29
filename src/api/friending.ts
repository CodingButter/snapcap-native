/**
 * Friend graph mutations: add friends, (eventually) remove, accept, etc.
 *
 * Service: snapchat.friending.server.FriendAction
 * Method:  AddFriends
 *
 * Wire shape decoded from captured traffic. Notably this RPC encodes the
 * target user's UUID as a {highBits, lowBits} fixed64 pair (instead of
 * the bytes16 wrapper used by AtlasGw / messaging). Both encodings are
 * for the same 128-bit UUID; the choice is per-schema.
 */
import { ProtoWriter, uuidToHighLow } from "../transport/proto-encode.ts";
import type { GrpcMethodDesc } from "../transport/grpc-web.ts";

const SERVICE = { serviceName: "snapchat.friending.server.FriendAction" };

/**
 * AddFriends action enum. Only ADD seen in captured traffic; other values
 * (REMOVE, BLOCK, …) likely exist on the server but aren't reverse-engineered
 * yet. Surface as we encounter them.
 */
export const FriendAction = {
  ADD: 2,
} as const;

export type AddFriendsRequest = {
  /** Origin label — Snap surfaces the source so analytics can attribute. */
  source?: string;
  /** UUID(s) to befriend. */
  userIds: string[];
};

const ADD_FRIENDS_DESC: GrpcMethodDesc<AddFriendsRequest, Record<string, unknown>> = {
  methodName: "AddFriends",
  service: SERVICE,
  requestType: {
    serializeBinary(this: AddFriendsRequest): Uint8Array {
      // wire shape (one repeated friend per call):
      //   { 1: string source,
      //     2: { 1: { 1: fixed64 highBits, 2: fixed64 lowBits }, 2: int32 action } }
      const w = new ProtoWriter();
      w.fieldString(1, this.source ?? "dweb_add_friend");
      for (const uuid of this.userIds) {
        const { high, low } = uuidToHighLow(uuid);
        w.fieldMessage(2, (item) => {
          item.fieldMessage(1, (id) => {
            id.fieldFixed64(1, high);
            id.fieldFixed64(2, low);
          });
          item.fieldVarint(2, FriendAction.ADD);
        });
      }
      return w.finish();
    },
  },
  responseType: {
    decode: (_b: Uint8Array): Record<string, unknown> => ({}),
  },
};

export type Rpc = {
  unary: (
    method: GrpcMethodDesc<unknown, unknown>,
    request: unknown,
  ) => Promise<unknown>;
};

export async function addFriends(rpc: Rpc, userIds: string[], source?: string): Promise<void> {
  await rpc.unary(
    ADD_FRIENDS_DESC as unknown as GrpcMethodDesc<unknown, unknown>,
    { userIds, source } satisfies AddFriendsRequest,
  );
}
