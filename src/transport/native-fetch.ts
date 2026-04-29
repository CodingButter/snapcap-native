/**
 * Capture Node/Bun's real `fetch` before anything installs happy-dom shims.
 *
 * `installShims()` (called transitively by bootKameleon) replaces
 * globalThis.fetch with happy-dom's implementation, which silently strips
 * Set-Cookie headers from responses (cookies live on the document instead).
 * The bridge needs Set-Cookie to drive the auth-session cookie jar, so we
 * snapshot the original at module-load time and route every external HTTP
 * call through this reference.
 *
 * Side-effecting on import: any module that needs nativeFetch should import
 * THIS file first, before kameleon.ts or anything that triggers shim
 * installation.
 */
export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
