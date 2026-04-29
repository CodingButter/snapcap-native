/**
 * gRPC-Web unary call helper.
 *
 * Snap's bundle ships every gRPC method as a "descriptor" — an object with
 * methodName, service.serviceName, requestType.serializeBinary, and
 * responseType.decode. This module takes a descriptor + a typed request and
 * does the framing + POST + response-frame strip + decode.
 *
 * Auto-refresh: when an authenticated call returns 401, we mint a fresh
 * bearer (via the supplied refresh callback) and retry once. The bearer is
 * short-lived and the refresh path doesn't require re-entering credentials,
 * so this stays invisible to callers.
 */
import type { CookieJar } from "tough-cookie";
import { makeJarFetch } from "./cookies.ts";

export type GrpcMethodDesc<Req, Resp> = {
  methodName: string;
  service: { serviceName: string };
  // Bundle uses two conventions:
  //   - newer ts-proto modules expose responseType.decode + requestType.serializeBinary that calls .encode().finish()
  //   - older protoc-gen-grpc-web modules (AtlasGw etc.) use responseType.deserializeBinary
  // Both have requestType.serializeBinary; only the response side differs.
  requestType: { serializeBinary: (this: Req) => Uint8Array };
  responseType:
    | { decode: (b: Uint8Array) => Resp }
    | { deserializeBinary: (b: Uint8Array) => Resp };
};

export type CallRpcOpts<Req, Resp> = {
  method: GrpcMethodDesc<Req, Resp>;
  request: Req;
  /** Hostname like "https://web.snapchat.com" — no trailing slash, no path. */
  host: string;
  jar: CookieJar;
  userAgent: string;
  /** Bearer to send. Omit for unauthenticated services like login. */
  bearer?: string;
  /** Called on 401 to mint a fresh bearer; if returns null, surface the 401. */
  refreshBearer?: () => Promise<string | null>;
  origin?: string;
  referer?: string;
};

export async function callRpc<Req, Resp>(opts: CallRpcOpts<Req, Resp>): Promise<Resp> {
  const url = `${opts.host}/${opts.method.service.serviceName}/${opts.method.methodName}`;
  const reqBytes = opts.method.requestType.serializeBinary.call(opts.request);
  const framed = frameGrpcWeb(reqBytes);
  const jarFetch = makeJarFetch(opts.jar, opts.userAgent);

  const send = async (bearer: string | undefined): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      // grpc-web library version — Snap's gateways check this is set.
      "x-user-agent": "grpc-web-javascript/0.1",
      // Snap's app-level UA. Server validates this for write operations
      // (CreateContentMessage etc.) and rejects with "invalid user agent"
      // if missing or wrong-format. The regular User-Agent isn't enough.
      "x-snap-client-user-agent": "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
    };
    if (bearer) headers["authorization"] = `Bearer ${bearer}`;
    if (opts.origin) headers["origin"] = opts.origin;
    if (opts.referer) headers["referer"] = opts.referer;
    return jarFetch(url, {
      method: "POST",
      headers,
      body: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer,
    });
  };

  let resp = await send(opts.bearer);
  if (resp.status === 401 && opts.refreshBearer) {
    const fresh = await opts.refreshBearer();
    if (fresh) resp = await send(fresh);
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (resp.status !== 200) {
    throw new Error(
      `gRPC ${opts.method.service.serviceName}/${opts.method.methodName} HTTP ${resp.status}: ${new TextDecoder().decode(buf).slice(0, 200)}`,
    );
  }
  // Some Snap services (e.g. CreateContentMessage success) return 200 with
  // a 0-byte body — gRPC trailers ride on HTTP trailer headers instead of
  // a trailer frame. Treat that as an empty-message success unless the
  // grpc-status header explicitly says otherwise.
  if (buf.byteLength === 0) {
    const grpcStatus = resp.headers.get("grpc-status");
    if (grpcStatus && grpcStatus !== "0") {
      throw new Error(
        `gRPC ${opts.method.service.serviceName}/${opts.method.methodName} grpc-status=${grpcStatus} ${resp.headers.get("grpc-message") ?? ""}`,
      );
    }
    return decodeRespBytes(opts.method.responseType, new Uint8Array(0));
  }
  if (buf.byteLength < 5) {
    throw new Error(`gRPC response too short to be framed (${buf.byteLength} bytes)`);
  }
  // First frame is data (flag 0). Subsequent trailer frame (flag 0x80)
  // carries grpc-status — we ignore it for now since 200+empty payload
  // is a valid success.
  const flag = buf[0]!;
  if ((flag & 0x80) !== 0) {
    // Trailer-only response — no data to decode. Synthesize an empty msg.
    return decodeRespBytes(opts.method.responseType, new Uint8Array(0));
  }
  const dataLen = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);
  return decodeRespBytes(opts.method.responseType, buf.subarray(5, 5 + dataLen));
}

function decodeRespBytes<Resp>(
  responseType: { decode: (b: Uint8Array) => Resp } | { deserializeBinary: (b: Uint8Array) => Resp },
  bytes: Uint8Array,
): Resp {
  if ("decode" in responseType && typeof responseType.decode === "function") {
    return responseType.decode(bytes);
  }
  if ("deserializeBinary" in responseType && typeof responseType.deserializeBinary === "function") {
    return responseType.deserializeBinary(bytes);
  }
  throw new Error("response type has neither decode nor deserializeBinary");
}

function frameGrpcWeb(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = 0;
  new DataView(out.buffer).setUint32(1, payload.byteLength, false);
  out.set(payload, 5);
  return out;
}
