/**
 * Central logger module — structured network observability for the SDK.
 *
 * Why this exists:
 *   Up to now the shims (`shims/xml-http-request.ts`, `shims/fetch.ts`) and
 *   the host-realm transport (`transport/native-fetch.ts`) were silent. Every
 *   "the SDK called X" claim was inference, not observation. This module gives
 *   the shims a single, opt-in, no-allocation-when-disabled log channel.
 *
 * Design:
 *   - `LogEvent` is a closed discriminated union; emit sites construct one
 *     plain object literal per event (no per-event class instances).
 *   - `setLogger(fn)` installs / replaces / clears the active handler.
 *   - `log(event)` is the internal entry point; when no handler is installed,
 *     it returns immediately (a single null check, no event-object allocation
 *     by the logger itself — the caller must still build the event, but the
 *     hot path early-outs before any handler work).
 *   - `defaultTextLogger` is a built-in one-line-per-event formatter
 *     consumers can opt into (or that the env-var bootstrap installs).
 *
 * Default behaviour:
 *   - If `process.env.SNAP_NETLOG === "1"` at module load, install
 *     `defaultTextLogger`. Otherwise the channel is silent.
 *
 * Body bytes are NEVER logged — only sizes. The SDK's traffic carries
 * bearer tokens, message content, etc.; sizes are safe.
 */

/** All emitted log events. Add new variants as needed. */
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

export type Logger = (event: LogEvent) => void;

/** Active handler. `undefined` means logging is off and `log()` is a no-op. */
let activeLogger: Logger | undefined;

/**
 * Install (or clear) the active logger. Pass `undefined` to disable logging
 * entirely — `log()` becomes a one-instruction null check after that.
 */
export function setLogger(fn: Logger | undefined): void {
  activeLogger = fn;
}

/**
 * Internal emit point — shims and transport call this. When no logger is
 * installed, this returns immediately. Handler crashes are swallowed so a
 * bad logger can never break the network path.
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
 * newlines. Tag column is fixed-width (13 chars incl. brackets) so the
 * output aligns regardless of which event variant is being logged.
 *
 * Examples:
 *   [net.xhr.open ] POST https://web.snapchat.com/.../AddFriends
 *   [net.xhr.done ] POST https://web.snapchat.com/.../AddFriends -> 200 (req 87B / resp 0B / 437ms / grpc-status:0)
 *   [net.xhr.error] POST https://web.snapchat.com/.../SyncFriendData -> "Network error" (1203ms)
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
