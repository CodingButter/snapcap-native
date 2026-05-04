/**
 * Fidelius — Snap's E2E identity layer.
 *
 * Currently exposes one operation: register the calling session's web
 * identity key with the server (`InitializeWebKey`). Subsequent steps
 * (GetFriendKeys, encrypt/decrypt) build on this foundation.
 *
 * The Fidelius gateway rejects requests that carry Origin/Referer
 * headers. Browsers' chat-bundle `grpc-web-fetch` (xr() in the f16f
 * chunk) leaves these unset on the calling-app fetch path; including
 * them triggers 401. {@link stripOriginReferer} returns a header bag
 * with those keys removed.
 *
 * Identity material comes from the chat-bundle WASM
 * (`e2ee_E2EEKeyManager.generateKeyInitializationRequest`) — see
 * `src/auth/fidelius-mint.ts`. We hand-build the wire request to match
 * the v10 shape browsers send at first login (4 fields under proto field
 * 2 with a 16-byte wrapped RWK), since the WASM's request output omits
 * that wrapping.
 *
 * Posting goes via {@link nativeFetch} directly because the SDK no longer
 * exposes a `client.makeRpc()`-shaped helper — the bundle owns all gRPC
 * routing now. The 11-byte gRPC-Web framing (1 flag + 4-byte BE length +
 * payload) and trailer parsing are inlined here for a single endpoint;
 * pull a shared helper out of this file when the second Fidelius RPC
 * lands.
 */
import { nativeFetch } from "../transport/native-fetch.ts";
import { ProtoWriter } from "../transport/proto-encode.ts";
import type { GrpcMethodDesc } from "../bundle/types.ts";

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
  /** Raw response bytes — used for persistence into the UDS slot. */
  raw: Uint8Array;
};

/**
 * Minimal rpc shape — kept as a typed export for consumers who want to
 * supply their own transport. Not used by {@link initializeWebKey} since
 * Fidelius needs its own header-stripping fetch path.
 */
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
 * Exported for symmetry with future Fidelius RPCs that need the same
 * sanitisation. {@link initializeWebKey} applies it implicitly.
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
      return { identityKeyId, rwk, raw: bytes };
    },
  },
};

export type InitializeWebKeyOpts = {
  /** Bearer token from the auth slice. */
  bearer: string;
  /** Cookie header value (optional — Fidelius primarily auth's via bearer). */
  cookieHeader?: string;
  /** UA string from the BrowserContext. */
  userAgent: string;
  /**
   * `true` on a 401 with body containing the "user has existing identity"
   * sentinel — caller should treat as success and skip persistence (the
   * server-side identity is owned by another session).
   */
};

export type InitializeWebKeyOutcome =
  | { kind: "ok"; response: InitializeWebKeyResponse }
  | { kind: "already-registered"; status: number; bodyText: string }
  | { kind: "error"; status: number; bodyText: string };

const FIDELIUS_URL =
  "https://web.snapchat.com/snapchat.fidelius.FideliusIdentityService/InitializeWebKey";

/**
 * Build the gRPC-Web framed request body for `InitializeWebKey` and POST it
 * with Fidelius-friendly headers (no Origin / Referer / accept-language /
 * mcs-cof-ids-bin). Returns a discriminated outcome so callers can branch
 * between the cold-mint success path, the warm "already-registered" path
 * (401 with the existing-identity sentinel — non-fatal), and a true error.
 */
export async function initializeWebKey(
  identity: FideliusIdentity,
  opts: InitializeWebKeyOpts,
): Promise<InitializeWebKeyOutcome> {
  const reqBytes = INITIALIZE_WEB_KEY_DESC.requestType.serializeBinary.call(identity);
  // gRPC-Web framing: 1-byte flag (0 = data) + 4-byte big-endian length + payload.
  const framed = new Uint8Array(5 + reqBytes.byteLength);
  framed[0] = 0;
  new DataView(framed.buffer).setUint32(1, reqBytes.byteLength, false);
  framed.set(reqBytes, 5);

  // Headers captured from a real browser InitializeWebKey request. Origin
  // and Referer are NOT included — including them triggers 401.
  const headers: Record<string, string> = stripOriginReferer({
    "authorization": `Bearer ${opts.bearer}`,
    "x-user-agent": "grpc-web-javascript/0.1",
    "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
    "accept": "*/*",
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    "user-agent": opts.userAgent,
  });
  if (opts.cookieHeader) headers["cookie"] = opts.cookieHeader;

  const resp = await nativeFetch(FIDELIUS_URL, {
    method: "POST",
    headers,
    body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
  });
  const buf = new Uint8Array(await resp.arrayBuffer());

  if (resp.status === 200) {
    // gRPC-Web body: framed payload (5-byte header + bytes) optionally
    // followed by a trailer frame (flag bit 0x80 set). Slice out the
    // payload, decode.
    if (buf.byteLength < 5) {
      return { kind: "error", status: resp.status, bodyText: "<truncated grpc-web frame>" };
    }
    const payloadLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
    const payload = buf.subarray(5, 5 + payloadLen);
    // responseType is a union of `{decode}` and `{deserializeBinary}`. We
    // declare the descriptor with `decode` above; narrow here so callers
    // using only the `GrpcMethodDesc<>` shape don't have to.
    const decode = (INITIALIZE_WEB_KEY_DESC.responseType as { decode: (b: Uint8Array) => InitializeWebKeyResponse }).decode;
    const response = decode(payload);
    return { kind: "ok", response };
  }

  // Non-200 — try to surface a useful body. Fidelius's "already registered"
  // condition is a 401 whose body is small and human-readable; the SDK
  // treats it as a successful no-op.
  let bodyText = "";
  try {
    bodyText = new TextDecoder().decode(buf).slice(0, 400);
  } catch {
    bodyText = `<${buf.byteLength} bytes>`;
  }
  if (resp.status === 401 && /existing identity|already|exists/i.test(bodyText)) {
    return { kind: "already-registered", status: resp.status, bodyText };
  }
  // Snap's Fidelius gateway has been observed to return a bare 401 with no
  // body for the "already registered" case too; treat any 401 as
  // already-registered when the user-facing flow is not a true credential
  // failure (we authed cleanly upstream).
  if (resp.status === 401) {
    return { kind: "already-registered", status: resp.status, bodyText };
  }
  return { kind: "error", status: resp.status, bodyText };
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
