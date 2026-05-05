/**
 * Construction helper for the per-instance {@link ClientContext} bag.
 *
 * Centralized here so `client.ts` doesn't have to know the layout of
 * the context. The sandbox must already be installed (via
 * `installShims`) before this is called — `client.ts` does that eagerly
 * in its constructor.
 *
 * @internal
 */
import type { Sandbox } from "../../shims/sandbox.ts";
import type { ClientContext } from "../_context.ts";

/**
 * Build a `ClientContext` from the shape `SnapcapClient` constructs at
 * boot.
 *
 * Centralized here so `client.ts` doesn't have to know the layout of the
 * context.
 *
 * @remarks
 * The sandbox is required to be already installed (via `installShims`)
 * before this is called — `client.ts` does that eagerly in its
 * constructor.
 *
 * @internal
 */
export async function makeContext(opts: {
  sandbox: Sandbox;
  dataStore: ClientContext["dataStore"];
  jar: ClientContext["jar"];
  userAgent: string;
}): Promise<ClientContext> {
  return {
    sandbox: opts.sandbox,
    jar: opts.jar,
    dataStore: opts.dataStore,
    userAgent: opts.userAgent,
  };
}
