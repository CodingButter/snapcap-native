/**
 * [TRACE-INSTRUMENTATION] — wrap `En.registerDuplexHandler` so we observe
 * every duplex registration the bundle (or the SDK's presence-bridge)
 * requests AND every `send()` invoked on the returned handle.
 *
 * Removable in one commit by deleting the call in `setup.ts` and this
 * file — keeping it as its own module makes that future cleanup trivial.
 *
 * @internal
 */

type DuplexHandlerHandleLike = {
  send?: (channel: string, bytes: Uint8Array) => unknown;
  unregisterHandler?: () => void;
} & Record<string, unknown>;

type EnEngineLike = {
  registerDuplexHandler?: (
    path: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
  ) => unknown;
};

/**
 * Mutates `En` in-place: replaces `registerDuplexHandler` with a wrapped
 * version that traces every entry / receive / send.
 *
 * No-op when `En.registerDuplexHandler` isn't a function — surfaces a
 * `NOT A FUNCTION` log line so the regression is visible.
 */
export function instrumentRegisterDuplexHandler(En: EnEngineLike): void {
  if (typeof En.registerDuplexHandler !== "function") {
    process.stderr.write(
      `[trace.chat-loader.En.registerDuplexHandler] NOT A FUNCTION — cannot wrap (typeof=${typeof En.registerDuplexHandler})\n`,
    );
    return;
  }
  const origReg = En.registerDuplexHandler.bind(En);
  En.registerDuplexHandler = ((
    path: string,
    handler: { onReceive: (bytes: Uint8Array) => void },
  ) => {
    process.stderr.write(
      `[trace.chat-loader.En.registerDuplexHandler] ENTER path=${path} handlerKeys=[${handler ? Object.keys(handler).join(",") : "?"}]\n`,
    );
    // Wrap onReceive so inbound frames coming up from the standalone
    // duplex are visible at this layer too.
    const wrappedHandler = {
      onReceive: (bytes: Uint8Array): void => {
        process.stderr.write(
          `[trace.chat-loader.En.handler.onReceive] path=${path} bytes=${bytes?.byteLength ?? "?"}\n`,
        );
        try {
          handler.onReceive(bytes);
        } catch (e) {
          process.stderr.write(
            `[trace.chat-loader.En.handler.onReceive] inner threw=${(e as Error).message?.slice(0, 200)}\n`,
          );
        }
      },
    };
    const result = origReg(path, wrappedHandler) as
      | DuplexHandlerHandleLike
      | Promise<DuplexHandlerHandleLike>;
    const wrapHandle = (h: DuplexHandlerHandleLike): DuplexHandlerHandleLike => {
      if (!h || typeof h !== "object") {
        process.stderr.write(
          `[trace.chat-loader.En.registerDuplexHandler] RESULT non-object path=${path} type=${typeof h}\n`,
        );
        return h;
      }
      const handleKeys = Object.keys(h).join(",");
      process.stderr.write(
        `[trace.chat-loader.En.registerDuplexHandler] RESULT path=${path} handle.keys=[${handleKeys}]\n`,
      );
      if (typeof h.send === "function") {
        const origSend = h.send.bind(h);
        h.send = ((channel: string, bytes: Uint8Array): unknown => {
          process.stderr.write(
            `[trace.chat-loader.En.handle.send] ENTER path=${path} channel=${channel} bytes=${bytes?.byteLength ?? "?"}\n`,
          );
          try {
            const r = origSend(channel, bytes);
            process.stderr.write(
              `[trace.chat-loader.En.handle.send] EXIT path=${path} channel=${channel} ret=${typeof r}\n`,
            );
            return r;
          } catch (e) {
            process.stderr.write(
              `[trace.chat-loader.En.handle.send] THREW path=${path} channel=${channel} err=${(e as Error).message?.slice(0, 200)}\n`,
            );
            throw e;
          }
        }) as typeof h.send;
      } else {
        process.stderr.write(
          `[trace.chat-loader.En.registerDuplexHandler] RESULT path=${path} HAS NO send() method!\n`,
        );
      }
      return h;
    };
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<DuplexHandlerHandleLike>).then(wrapHandle);
    }
    return wrapHandle(result as DuplexHandlerHandleLike);
  }) as typeof En.registerDuplexHandler;
  process.stderr.write(
    `[trace.chat-loader.En.registerDuplexHandler] WRAP-INSTALLED on globalThis.__SNAPCAP_EN\n`,
  );
}
