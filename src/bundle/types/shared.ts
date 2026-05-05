/**
 * Bundle wire-format primitives — types used by 2+ sibling files in this
 * directory. The four primitives below are the lingua franca of every
 * bundle-shaped type the SDK touches:
 *
 *   - {@link GrpcMethodDesc} — descriptor envelope every gRPC call passes
 *     through (used by login, search, friends, and AtlasGw shapes).
 *   - {@link Uuid64Pair} — friend-graph UUID pair (used by friends, login,
 *     and search request shapes).
 *   - {@link UnaryFn} — gRPC transport callback (used by rpc and login
 *     constructor shapes).
 *   - {@link ConversationRef} — bytes16-wrapped conversation envelope
 *     (used by messaging, snap, and chat-store shapes).
 *
 * Keep this file primitive-only — anything that references a domain
 * shape (a slice, a manager class, a request envelope) belongs in its
 * sibling domain file, NOT here.
 */

/**
 * Snap's bundle ships every gRPC method as a "descriptor" — an object with
 * `methodName`, `service.serviceName`, `requestType.serializeBinary`, and
 * `responseType.decode` (newer ts-proto modules) or
 * `responseType.deserializeBinary` (older protoc-gen-grpc-web modules,
 * AtlasGw etc.). Both have `requestType.serializeBinary`; only the
 * response side differs.
 *
 * Lives in the bundle/types module because it's the bundle's wire-shape
 * descriptor — every api file that builds one is producing input the
 * bundle's transport accepts. The runtime helper that consumes it
 * (`callRpc`) still lives in `transport/grpc-web.ts`.
 *
 * @internal Bundle wire-format type tied to Snap's protos.
 */
export type GrpcMethodDesc<Req, Resp> = {
  methodName: string;
  service: { serviceName: string };
  requestType: { serializeBinary: (this: Req) => Uint8Array };
  responseType:
    | { decode: (b: Uint8Array) => Resp }
    | { deserializeBinary: (b: Uint8Array) => Resp };
};

/**
 * UUID encoded as a 64-bit high/low bigint pair — the convention used by
 * Snap's friending protos. The bundle's ts-proto codecs accept both
 * stringified and `bigint` inputs at `fromPartial` time.
 *
 * @internal Bundle wire-format type.
 */
export type Uuid64Pair = { highBits: bigint | string; lowBits: bigint | string };

/**
 * Generic gRPC unary fn shape — same structural type as
 * `Ni.rpc.unary` and `LoginClient`'s constructor argument. Re-exported
 * here so consumers passing a custom transport into `submitLogin` etc.
 * have a public type to satisfy.
 *
 * @internal Bundle wire-format type.
 */
export type UnaryFn = <TReq, TResp>(
  desc: GrpcMethodDesc<TReq, TResp>,
  req: TReq,
  metadata?: unknown,
) => Promise<TResp>;

/**
 * Conversation reference envelope used by every send-side bundle method —
 * `{id: bytes16, str: hyphenated-uuid}`. The api layer builds these via
 * `makeConversationRef` (in `../../api/_helpers.ts`); the registry exports
 * accept this shape directly without doing any UUID parsing themselves.
 *
 * @internal Bundle wire-format type.
 */
export type ConversationRef = { id: Uint8Array; str: string };
