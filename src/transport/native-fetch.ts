/**
 * Node/Bun's real `fetch`, used by the SDK for actual network traffic
 * (login, gRPC, media uploads). All Set-Cookie headers reach our cookie
 * jar through this reference because happy-dom's cookie-stripping fetch
 * never lands on the host globalThis — `installShims()` keeps happy-dom
 * scoped to the sandbox vm.Context (see `shims/sandbox.ts`).
 *
 * Eager-binding is preserved as defence-in-depth: if a future change ever
 * regresses sandbox isolation (e.g. someone reaches for GlobalRegistrator),
 * snapshotting at module load means we still get the un-shimmed fetch.
 */
export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
