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
 * Login credentials. Snap's WebLogin proto accepts identification by
 * `username`, `email`, or `phone` — pass exactly one identifier with
 * the password.
 *
 * Phone numbers should be in E.164 format (e.g. `+14155552671`).
 *
 * Optional on `SnapcapClientOpts` — warm-start scenarios where cookies
 * are already in the DataStore can omit credentials and rely on
 * cookie-based bearer mint. Required if cold-login is needed.
 */
export type Credentials = {
  username?: string;
  email?: string;
  phone?: string;
  password: string;
};

/**
 * Browser-context fingerprint settings. Together these define what
 * "browser" the SDK pretends to be when talking to Snap.
 *
 * `userAgent` is REQUIRED to make consumers think about UA hygiene up
 * front — if every `@snapcap/native` user defaulted to the same UA,
 * Snap's anti-fraud could detect "this UA + Node TLS fingerprint" as
 * a snapcap consumer. Pass a recent, realistic UA from a real browser;
 * for multi-tenant runners, pass a DIFFERENT UA per client (a JSON
 * tenant-config file is the natural shape — username, password, and
 * browser fingerprint per tenant).
 *
 * Other fields are optional but recommended for diversity in
 * multi-tenant deployments — match each tenant's locale, viewport,
 * and timezone to whatever real device they'd plausibly be using.
 */
export type BrowserContext = {
  /**
   * REQUIRED — User-Agent header sent on every request, AND surfaced
   * to bundle code via `navigator.userAgent`. Match a recent real
   * browser. Vary per client in multi-tenant deployments.
   *
   * @example "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
   */
  userAgent: string;
  /** Locale tag (BCP-47). Reserved for future Accept-Language threading. */
  locale?: string;
  /** Virtual viewport dimensions for happy-dom Window. Defaults to 1440x900. */
  viewport?: { width: number; height: number };
  /** Timezone identifier (IANA). Reserved for future happy-dom timezone setting. */
  timezone?: string;
};

/**
 * Pull the active identifier (and its `loginIdentifier` $case) out of a
 * `Credentials` object. Throws on no identifier OR multiple identifiers
 * — exactly one is required.
 *
 * Used by `api/auth.ts:fullLogin` to map the consumer-shape Credentials
 * into Snap's WebLogin proto `loginIdentifier` oneof, and by `client.ts`
 * to extract the identifier for `refreshAuthToken` / kameleon binding.
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
