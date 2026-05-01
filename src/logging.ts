/**
 * Central logger module — structured network observability for the SDK.
 *
 * @remarks
 * The shims (`shims/xml-http-request.ts`, `shims/fetch.ts`) and the host-realm
 * transport (`transport/native-fetch.ts`) emit {@link LogEvent} values
 * through this module so consumers can observe every request the SDK and the
 * bundle issue. The channel is opt-in:
 *
 * - Set `process.env.SNAP_NETLOG === "1"` at module load to install the
 *   built-in {@link defaultTextLogger}.
 * - OR call {@link setLogger} with your own handler at any point.
 * - Otherwise the channel is silent and the internal emit point early-outs
 *   on a single null-check (zero per-event handler work).
 *
 * **Body bytes are NEVER logged — only sizes.** The SDK's traffic carries
 * bearer tokens and message content; sizes are safe.
 *
 * @example
 * Install a custom JSON-line logger:
 *
 * ```ts
 * import { setLogger } from "@snapcap/native";
 *
 * setLogger((event) => {
 *   process.stdout.write(JSON.stringify({ ts: Date.now(), ...event }) + "\n");
 * });
 * ```
 *
 * @example
 * Use the built-in text formatter explicitly:
 *
 * ```ts
 * import { setLogger, defaultTextLogger } from "@snapcap/native";
 * setLogger(defaultTextLogger);
 * ```
 *
 * @see {@link Logger}
 * @see {@link LogEvent}
 * @see {@link defaultTextLogger}
 */

/**
 * All emitted log events. Closed discriminated union — switch on
 * `event.kind` to narrow.
 *
 * @remarks
 * Variants pair on protocol (`xhr` vs `fetch`) and lifecycle stage
 * (`open` / `done` / `error`). `done` events carry `reqBytes` /
 * `respBytes` (sizes only — never content) and an optional `grpcStatus` /
 * `grpcMessage` for gRPC-Web responses.
 *
 * @see {@link Logger}
 * @see {@link defaultTextLogger}
 */
export type LogEvent =
  | { kind: "net.xhr.open"; method: string; url: string }
  | {
      kind: "net.xhr.done";
      method: string;
      url: string;
      status: number;
      reqBytes: number;
      respBytes: number;
      durMs: number;
      grpcStatus?: string;
      grpcMessage?: string;
    }
  | {
      kind: "net.xhr.error";
      method: string;
      url: string;
      error: string;
      durMs: number;
    }
  | { kind: "net.fetch.open"; method: string; url: string }
  | {
      kind: "net.fetch.done";
      method: string;
      url: string;
      status: number;
      reqBytes: number;
      respBytes: number;
      durMs: number;
      grpcStatus?: string;
      grpcMessage?: string;
    }
  | {
      kind: "net.fetch.error";
      method: string;
      url: string;
      error: string;
      durMs: number;
    };

/**
 * Handler signature passed to {@link setLogger}.
 *
 * @param event - One emitted {@link LogEvent}. Switch on `event.kind` to
 *   narrow to a specific variant.
 *
 * @remarks
 * Handlers should return synchronously and avoid throwing — exceptions
 * thrown from a handler are swallowed by the internal emit point so a bad
 * logger can never break the network path, but they will be silently
 * dropped.
 */
export type Logger = (event: LogEvent) => void;

/** Active handler. `undefined` means logging is off and `log()` is a no-op. */
let activeLogger: Logger | undefined;

/**
 * Install (or clear) the active logger.
 *
 * @param fn - The handler to install, or `undefined` to disable logging
 *   entirely (in which case the internal emit point becomes a
 *   one-instruction null check).
 *
 * @example
 * ```ts
 * import { setLogger, defaultTextLogger } from "@snapcap/native";
 *
 * setLogger(defaultTextLogger);   // built-in text formatter
 * setLogger((ev) => myJsonLogger.log(ev));   // custom handler
 * setLogger(undefined);   // disable
 * ```
 *
 * @see {@link Logger}
 * @see {@link defaultTextLogger}
 */
export function setLogger(fn: Logger | undefined): void {
  activeLogger = fn;
}

/**
 * Internal emit point — shims and transport call this. When no logger is
 * installed, this returns immediately. Handler crashes are swallowed so a
 * bad logger can never break the network path.
 *
 * @internal
 */
export function log(event: LogEvent): void {
  const fn = activeLogger;
  if (!fn) return;
  try {
    fn(event);
  } catch {
    /* logger crash isolated — never break the network path */
  }
}

/** Format a duration in ms as a compact integer string. */
function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/** Format a byte count compactly. */
function fmtBytes(n: number): string {
  return `${n}B`;
}

/**
 * Built-in human-readable formatter. One line per event, no embedded
 * newlines. Tag column is fixed-width (15 chars) so the output aligns
 * regardless of which event variant is being logged.
 *
 * @remarks
 * Pass to {@link setLogger} to enable, or set `SNAP_NETLOG=1` in the
 * environment to install at module load.
 *
 * Sample output:
 *
 * ```text
 * [net.xhr.open  ] POST https://web.snapchat.com/.../AddFriends
 * [net.xhr.done  ] POST https://web.snapchat.com/.../AddFriends -> 200 (req 87B / resp 0B / 437ms / grpc-status:0)
 * [net.xhr.error ] POST https://web.snapchat.com/.../SyncFriendData -> "Network error" (1203ms)
 * ```
 *
 * @example
 * ```ts
 * import { setLogger, defaultTextLogger } from "@snapcap/native";
 * setLogger(defaultTextLogger);
 * ```
 *
 * @see {@link setLogger}
 * @see {@link Logger}
 */
export const defaultTextLogger: Logger = (event) => {
  // Pad the kind so all tags are the same width: longest kind is
  // "net.fetch.error" (15 chars). Pad to that.
  const tag = event.kind.padEnd(15, " ");
  switch (event.kind) {
    case "net.xhr.open":
    case "net.fetch.open":
      console.log(`[${tag}] ${event.method} ${event.url}`);
      return;
    case "net.xhr.done":
    case "net.fetch.done": {
      const grpc =
        event.grpcStatus !== undefined
          ? ` / grpc-status:${event.grpcStatus}${
              event.grpcMessage ? ` "${event.grpcMessage}"` : ""
            }`
          : "";
      console.log(
        `[${tag}] ${event.method} ${event.url} -> ${event.status} (req ${fmtBytes(
          event.reqBytes,
        )} / resp ${fmtBytes(event.respBytes)} / ${fmtMs(event.durMs)}${grpc})`,
      );
      return;
    }
    case "net.xhr.error":
    case "net.fetch.error":
      console.log(
        `[${tag}] ${event.method} ${event.url} -> "${event.error}" (${fmtMs(event.durMs)})`,
      );
      return;
  }
};

// Bootstrap: opt in via env var at module load. Cheap (one process.env read)
// and matches the convention other Node tooling uses (DEBUG=…, NODE_DEBUG=…).
if (typeof process !== "undefined" && process.env?.SNAP_NETLOG === "1") {
  activeLogger = defaultTextLogger;
}
