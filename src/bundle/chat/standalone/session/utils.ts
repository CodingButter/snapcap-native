/**
 * Small stringify helpers used by the session bring-up + delegate hooks.
 *
 * Both have to survive Embind quirks (BigInt fields the bundle hands out
 * for i64/u64 protos) and circular references (delegate args sometimes
 * include parent session refs).
 *
 * @internal
 */

/**
 * `JSON.stringify` replacer that survives BigInt — Embind hands us i64/u64
 * fields as BigInt and the bundle's analytics paths choke on them. We
 * coerce to string for log purposes only.
 */
export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() + "n" : v;
}

/**
 * Cross-realm-safe value stringifier that survives BigInt + circular refs.
 * Returns short tokens for `undefined` / `null`, plain `String(v)` for
 * primitives, and a best-effort JSON dump (with BigInt coercion) for
 * objects. Falls back to `[unserial]` rather than throwing.
 */
export function safeStringifyVal(v: unknown): string {
  if (v === undefined) return "undef";
  if (v === null) return "null";
  if (typeof v === "bigint") return v.toString() + "n";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return String(v);
  try {
    return JSON.stringify(v, (_k, vv) => (typeof vv === "bigint" ? vv.toString() + "n" : vv));
  } catch {
    return "[unserial]";
  }
}
