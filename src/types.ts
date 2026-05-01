/**
 * Cross-layer SDK types — public type definitions used by both `client.ts`
 * and the `api/*` files. Kept in one root-level file so types referenced
 * across the api/client boundary don't form circular deps.
 *
 * Distinct from:
 *   - `bundle/types.ts` — wire-format types matching Snap's proto shapes
 *   - `shims/types.ts`  — types internal to the shim layer
 *
 * Anything here is part of the public surface (re-exported through
 * `index.ts`). Layer-internal types stay in their own subdirectory.
 */

/**
 * Login credentials passed to {@link SnapcapClient}'s constructor.
 *
 * Snap's WebLogin proto identifies an account by exactly one of `username`,
 * `email`, or `phone`. Pass that single identifier together with `password`.
 *
 * @remarks
 * Phone numbers should be in E.164 format (e.g. `+14155552671`).
 *
 * Optional on `SnapcapClientOpts` — warm-start scenarios where cookies are
 * already in the {@link DataStore} can omit credentials entirely and rely on
 * cookie-based bearer mint. Required if cold-login is needed.
 *
 * Use {@link activeIdentifier} to extract the identifier-type pair from a
 * `Credentials` value at runtime.
 *
 * @example
 * Username + password (most common):
 * ```ts
 * const creds: Credentials = { username: "alice", password: "..." };
 * ```
 *
 * @example
 * Email or phone instead of username:
 * ```ts
 * const byEmail: Credentials = { email: "alice@example.com", password: "..." };
 * const byPhone: Credentials = { phone: "+14155552671", password: "..." };
 * ```
 *
 * @see {@link activeIdentifier}
 * @see {@link BrowserContext}
 */
export type Credentials = {
  /** Snap username. Pass exactly one of `username`, `email`, or `phone`. */
  username?: string;
  /** Email address registered to the account. Pass exactly one identifier. */
  email?: string;
  /** Phone number in E.164 format (e.g. `+14155552671`). Pass exactly one identifier. */
  phone?: string;
  /** Account password. Always required. */
  password: string;
};

/**
 * Browser-context fingerprint settings — what "browser" the SDK pretends to
 * be when talking to Snap.
 *
 * @remarks
 * `userAgent` is REQUIRED to make consumers think about UA hygiene up front.
 * If every `@snapcap/native` consumer defaulted to the same UA, Snap's
 * anti-fraud could detect "this UA + Node TLS fingerprint" as a snapcap
 * consumer. Pass a recent, realistic UA from a real browser; for multi-tenant
 * runners, pass a DIFFERENT UA per client (a JSON tenant-config file is the
 * natural shape — username, password, and browser fingerprint per tenant).
 *
 * Other fields are optional but recommended for diversity in multi-tenant
 * deployments — match each tenant's locale, viewport, and timezone to
 * whatever real device they'd plausibly be using.
 *
 * @example
 * ```ts
 * const browser: BrowserContext = {
 *   userAgent:
 *     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
 *   locale: "en-US",
 *   viewport: { width: 1440, height: 900 },
 *   timezone: "America/Los_Angeles",
 * };
 * ```
 *
 * @see {@link Credentials}
 */
export type BrowserContext = {
  /**
   * REQUIRED — User-Agent header sent on every request, AND surfaced to bundle
   * code via `navigator.userAgent`. Match a recent real browser. Vary per
   * client in multi-tenant deployments.
   *
   * @example
   * `"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"`
   */
  userAgent: string;
  /** Locale tag (BCP-47). Reserved for future Accept-Language threading. */
  locale?: string;
  /** Virtual viewport dimensions for happy-dom Window. Defaults to 1440×900. */
  viewport?: { width: number; height: number };
  /** Timezone identifier (IANA). Reserved for future happy-dom timezone setting. */
  timezone?: string;
};

/**
 * Pull the active identifier (and its `loginIdentifier` `$case`) out of a
 * {@link Credentials} object.
 *
 * @remarks
 * Used by `api/auth.ts:fullLogin` to map the consumer-shape Credentials into
 * Snap's WebLogin proto `loginIdentifier` oneof, and by `client.ts` to extract
 * the identifier for `refreshAuthToken` / kameleon binding.
 *
 * @param c - The credentials to inspect.
 * @returns A `{ type, value }` pair where `type` is the identifier kind
 *   (`"username"`, `"email"`, or `"phone"`) and `value` is the supplied
 *   identifier string.
 * @throws If no identifier is set, or if more than one identifier is set —
 *   exactly one is required.
 *
 * @example
 * ```ts
 * activeIdentifier({ username: "alice", password: "..." });
 * // { type: "username", value: "alice" }
 * ```
 */
export function activeIdentifier(c: Credentials): { type: "username" | "email" | "phone"; value: string } {
  const set: Array<{ type: "username" | "email" | "phone"; value: string }> = [];
  if (c.username) set.push({ type: "username", value: c.username });
  if (c.email)    set.push({ type: "email",    value: c.email });
  if (c.phone)    set.push({ type: "phone",    value: c.phone });
  if (set.length === 0) {
    throw new Error("Credentials require exactly one of: username, email, phone");
  }
  if (set.length > 1) {
    throw new Error(`Credentials specify multiple identifiers: ${set.map(s => s.type).join(", ")} — pass only one`);
  }
  return set[0]!;
}
