/**
 * Sandbox `self.location` patch.
 *
 * The chat bundle's module 13094 reads `self.location.pathname` at
 * top-level eval and throws if it doesn't start with "/web". The
 * accounts bundle leaves us on "accounts.snapchat.com/v2/login" by
 * default, so we proxy `location` to look like the realm is parked at
 * `https://web.snapchat.com/web` for the chat-bundle's pathname guard.
 *
 * @internal
 */
import type { ClientContext } from "../_context.ts";

/**
 * Replace `sandbox.window.location` with a Proxy that fakes
 * `pathname=/web` and friends. The chat bundle's module 13094 reads
 * `self.location.pathname` at top-level eval and throws if it doesn't
 * start with "/web"; the accounts bundle leaves us on
 * "accounts.snapchat.com/v2/login" by default, so we proxy.
 *
 * Idempotent — re-calls overwrite with the same proxy.
 *
 * @internal
 */
export function patchSandboxLocationToWeb(ctx: ClientContext): void {
  const sandbox = ctx.sandbox;
  const prevLoc = sandbox.runInContext("self.location") as {
    href: string;
    pathname: string;
    origin?: string;
    protocol?: string;
    host?: string;
    hostname?: string;
  };
  // Already patched? Use `host` as the idempotency marker — happy-dom
  // defaults to `www.snapchat.com`, the proxy rewrites to `web.snapchat.com`.
  // (Earlier this guarded on `pathname === "/web"`, which always matched
  // because happy-dom's default pathname is also `/web` — so the proxy
  // never installed and `href`/`host` stayed wrong.)
  try {
    if (prevLoc.host === "web.snapchat.com") return;
  } catch {
    // proxy may have a getter that throws on probe — fall through and re-wrap.
  }
  const patchedLoc = new Proxy(prevLoc, {
    get(target, prop) {
      if (prop === "pathname") return "/web";
      if (prop === "href") return "https://web.snapchat.com/web";
      if (prop === "origin") return "https://web.snapchat.com";
      if (prop === "host" || prop === "hostname") return "web.snapchat.com";
      return Reflect.get(target, prop);
    },
  });
  (sandbox.window as { location: unknown }).location = patchedLoc;
}
