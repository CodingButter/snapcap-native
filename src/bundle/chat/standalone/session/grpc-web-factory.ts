/**
 * Register the gRPC-Web client factory the bundle's `GrpcManager` uses
 * for Fidelius gateway calls (key lookups, etc.). Routes the requests
 * through the SDK's native fetch + cookie jar so authentication piggy-
 * backs on the SSO bearer + jar without crossing realm boundaries.
 *
 * Implements only `unaryCall` for real; the streaming variants (server +
 * bidi) hand back a `12 stream-not-implemented` synchronously since the
 * bundle's WASM never uses them on this path.
 *
 * @internal
 */
import type { CookieJar } from "tough-cookie";
import { nativeFetch } from "../../../../transport/native-fetch.ts";
import type { EmModule } from "./types.ts";

/**
 * Register the web factory on `Module.grpc_GrpcManager` if present.
 * No-ops when the WASM build lacks `registerWebFactory`.
 */
export function registerGrpcWebFactory(opts: {
  Module: EmModule;
  bearer: string;
  userAgent: string;
  cookieJar: CookieJar;
  log: (line: string) => void;
  /** Standalone-realm Uint8Array — used for the response wasmBuf alloc. */
  VmU8: Uint8ArrayConstructor;
}): void {
  const { Module, bearer, userAgent, cookieJar, log, VmU8 } = opts;
  const GrpcManager = (Module as Record<string, unknown>).grpc_GrpcManager as Record<
    string,
    Function
  >;
  if (!GrpcManager || typeof GrpcManager.registerWebFactory !== "function") return;

  GrpcManager.registerWebFactory({
    createClient: () => ({
      unaryCall: (
        path: string,
        body: Uint8Array,
        _o: unknown,
        cb: { onEvent?: Function } | undefined,
      ) => {
        const framed = new Uint8Array(5 + body.byteLength);
        new DataView(framed.buffer).setUint32(1, body.byteLength, false);
        framed.set(body, 5);
        const url = `https://web.snapchat.com${path}`;
        (async () => {
          try {
            const cookieHeader = await cookieJar.getCookieString(url);
            const headers: Record<string, string> = {
              "content-type": "application/grpc-web+proto",
              "x-grpc-web": "1",
              authorization: `Bearer ${bearer}`,
              "user-agent": userAgent,
              "x-snap-client-user-agent":
                "SnapchatWeb/13.79.0 PROD (linux 0.0.0; chrome 147.0.0.0)",
              "x-user-agent": "grpc-web-javascript/0.1",
            };
            if (cookieHeader) headers.cookie = cookieHeader;
            const r = await nativeFetch(url, {
              method: "POST",
              headers,
              body: framed,
            });
            const respBuf = new Uint8Array(await r.arrayBuffer());
            if (r.status !== 200) {
              cb?.onEvent?.(undefined, {
                statusCode: 12,
                errorString: `HTTP ${r.status}`,
              });
              return;
            }
            let p = 0;
            let dataPayload: Uint8Array | undefined;
            let trailerCode = 0;
            let trailerMsg = "";
            while (p < respBuf.byteLength) {
              if (p + 5 > respBuf.byteLength) break;
              const flag = respBuf[p]!;
              const fLen = new DataView(
                respBuf.buffer,
                respBuf.byteOffset + p + 1,
                4,
              ).getUint32(0, false);
              const start = p + 5;
              const end = start + fLen;
              if (end > respBuf.byteLength) break;
              const slice = respBuf.subarray(start, end);
              if ((flag & 0x80) === 0) {
                dataPayload = slice;
              } else {
                const trailerStr = new TextDecoder().decode(slice);
                const m = trailerStr.match(/grpc-status:\s*(\d+)/i);
                if (m) trailerCode = parseInt(m[1]!);
                const mm = trailerStr.match(/grpc-message:\s*(.+)/i);
                if (mm) trailerMsg = mm[1]!.trim();
              }
              p = end;
            }
            if (trailerCode !== 0) {
              log(`[grpc.unary] trailer status=${trailerCode} msg=${trailerMsg}`);
              cb?.onEvent?.(undefined, {
                statusCode: trailerCode,
                errorString: trailerMsg,
              });
              return;
            }
            if (dataPayload) {
              const ptr = Module._malloc(dataPayload.byteLength);
              const wasmBuf = new VmU8(Module.HEAPU8.buffer, ptr, dataPayload.byteLength);
              wasmBuf.set(dataPayload);
              cb?.onEvent?.(wasmBuf, { statusCode: 0, errorString: "" });
            } else {
              cb?.onEvent?.(undefined, {
                statusCode: 13,
                errorString: "no data frame",
              });
            }
          } catch (e) {
            log(`[grpc.unary] error: ${(e as Error).message}`);
            cb?.onEvent?.(undefined, {
              statusCode: 13,
              errorString: (e as Error).message,
            });
          }
        })();
      },
      serverStreamingCall: (
        _p: string,
        _b: Uint8Array,
        _o: unknown,
        cb: { onEvent?: Function } | undefined,
      ) => {
        setTimeout(
          () =>
            cb?.onEvent?.(undefined, {
              statusCode: 12,
              errorString: "stream-not-implemented",
            }),
          0,
        );
      },
      bidiStreamingCall: (
        _p: string,
        _o: unknown,
        cb: { onEvent?: Function } | undefined,
      ) => {
        setTimeout(
          () =>
            cb?.onEvent?.(undefined, {
              statusCode: 12,
              errorString: "stream-not-implemented",
            }),
          0,
        );
      },
    }),
  });
}
