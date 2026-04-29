/**
 * Fidelius — Snap's E2E identity layer.
 *
 * Currently exposes one operation: register the calling session's web
 * identity key with the server (`InitializeWebKey`). Subsequent steps
 * (GetFriendKeys, encrypt/decrypt) build on this foundation.
 *
 * The Fidelius gateway rejects requests that carry Origin/Referer
 * headers, which the SDK's default `makeRpc` adds for every call. This
 * module builds its own rpc with a header transform that strips them.
 *
 * Identity material comes from the chat-bundle WASM
 * (`e2ee_E2EEKeyManager.generateKeyInitializationRequest`) — the WASM
 * generates a fresh P-256 keypair + RWK and produces the proto bytes.
 * We hand-build the wire request to match the v10 shape browsers send
 * at first login (4 fields under proto field 2 with a 16-byte wrapped
 * RWK), since the WASM's request output omits that wrapping.
 */
import type { GrpcMethodDesc } from "../transport/grpc-web.ts";
import { ProtoWriter } from "../transport/proto-encode.ts";

/** Cleartext identity material as returned by the WASM. */
export type FideliusIdentity = {
  /** SEC1-uncompressed P-256 public key (65 bytes, 0x04 prefix). */
  cleartextPublicKey: Uint8Array;
  /** P-256 private key (32 bytes). */
  cleartextPrivateKey: Uint8Array;
  /** Server-side identifier for this key (32 bytes). */
  identityKeyId: Uint8Array;
  /** Root wrapping key (16 bytes) — locally encrypts persisted keys. */
  rwk: Uint8Array;
  /** Protocol version (10 = "TEN", current as of 2026-04). */
  version: number;
};

/** Server's response to InitializeWebKey — confirms registration. */
export type InitializeWebKeyResponse = {
  /** Echoed identity key id. */
  identityKeyId: Uint8Array;
  /** Echoed wrapped RWK. */
  rwk: Uint8Array;
};

export type Rpc = {
  unary: (method: GrpcMethodDesc<unknown, unknown>, request: unknown) => Promise<unknown>;
};

/**
 * Header transform for Fidelius gateway. Strips:
 *   - origin / referer  (Snap's chat-bundle grpc-web-fetch leaves these
 *     unset for the calling-app fetch path; including them triggers 401)
 *   - mcs-cof-ids-bin   (messaging-core-only — captured Fidelius browser
 *     calls don't send it)
 *   - accept-language   (also absent from captured Fidelius requests;
 *     matches what xr() in the f16f chunk emits)
 *
 * Pass to `client.makeRpc(stripOriginReferer)` for any Fidelius call.
 */
export function stripOriginReferer(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  delete out.origin;
  delete out.referer;
  delete out["mcs-cof-ids-bin"];
  delete out["accept-language"];
  return out;
}

const INITIALIZE_WEB_KEY_DESC: GrpcMethodDesc<FideliusIdentity, InitializeWebKeyResponse> = {
  methodName: "InitializeWebKey",
  service: { serviceName: "snapchat.fidelius.FideliusIdentityService" },
  requestType: {
    serializeBinary(this: FideliusIdentity): Uint8Array {
      // Wire shape (v10 / "TEN", lifted from a fresh-login HAR):
      //   field 2: {
      //     1: bytes(65)  cleartextPublicKey
      //     2: bytes(32)  identityKeyId
      //     3: bytes(16)  wrapped RWK
      //     4: varint     version (10)
      //   }
      const w = new ProtoWriter();
      w.fieldMessage(2, (m) => {
        m.fieldBytes(1, this.cleartextPublicKey);
        m.fieldBytes(2, this.identityKeyId);
        m.fieldBytes(3, this.rwk);
        m.fieldVarint(4, this.version);
      });
      return w.finish();
    },
  },
  responseType: {
    decode(bytes: Uint8Array): InitializeWebKeyResponse {
      // Response shape: { 1: bytes(16) rwk_id, 2: bytes(32) identityKeyId }
      let pos = 0;
      let identityKeyId = new Uint8Array(0);
      let rwk = new Uint8Array(0);
      while (pos < bytes.byteLength) {
        const [tag, p1] = readVarint(bytes, pos);
        pos = p1;
        const field = Number(tag >> 3n);
        const wt = Number(tag & 0x7n);
        if (wt !== 2) {
          // unknown wire type — skip
          if (wt === 0) {
            const [, p2] = readVarint(bytes, pos);
            pos = p2;
            continue;
          }
          break;
        }
        const [len, p2] = readVarint(bytes, pos);
        pos = p2;
        const slice = bytes.subarray(pos, pos + Number(len));
        pos += Number(len);
        if (field === 1) rwk = new Uint8Array(slice);
        else if (field === 2) identityKeyId = new Uint8Array(slice);
      }
      return { identityKeyId, rwk };
    },
  },
};

/**
 * Register `identity` with Snap's server. Idempotent on first call;
 * subsequent calls for an already-registered user return 401 (the
 * server lets each user mint exactly one web identity).
 */
export async function initializeWebKey(
  rpc: Rpc,
  identity: FideliusIdentity,
): Promise<InitializeWebKeyResponse> {
  return (await rpc.unary(
    INITIALIZE_WEB_KEY_DESC as unknown as GrpcMethodDesc<unknown, unknown>,
    identity,
  )) as InitializeWebKeyResponse;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.byteLength) {
    const b = buf[pos++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  return [result, pos];
}
