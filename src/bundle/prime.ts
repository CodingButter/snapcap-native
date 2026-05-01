/**
 * Bundle-plumbing: webpack module priming helpers.
 *
 * Several chat-bundle modules have factory-time cyclic deps that break
 * the SPA's lazy-load order in our headless realm. The cycle root is
 * module 94704 (the Zustand chat store) which spreads a slice from
 * module 33488 whose lazy export `wp.P` returns undefined mid-factory.
 * Webpack caches `module.exports` pre-factory, so a thrown factory
 * leaves an empty cache entry that shadows future `wreq("…")` calls.
 *
 * Workaround (used by both helpers below): re-run the target factory
 * through a SHIMMED webpack require that detours modules 94704 + 33488
 * to fresh `module`/`exports` factory calls (bypassing webpack's cache,
 * which is closure-private and can't be invalidated externally). The
 * shim copies all webpack-runtime helpers (`m`, `d`, `r`, `t`, `n`,
 * `p`, `s`, …) off the real wreq, and uses a per-module reentry guard
 * so the cycle doesn't recurse infinitely.
 *
 * Lives in `bundle/` (not `api/`) because the module IDs and
 * factory-rewire mechanism are bundle plumbing — api files should never
 * touch raw webpack ids or `wreq.m`.
 */
import { chatWreq } from "./register.ts";
import { getSandbox } from "../shims/runtime.ts";

// ─── Module IDs in the priming graph ─────────────────────────────────────
// These IDs are not "state lookup" references (those belong in
// register.ts); they identify the factories the priming routines must
// re-execute or rewire to break the cyclic-dep cache poisoning.

/** Zustand chat store factory — root of the cyclic dep. */
const MOD_CHAT_STORE = "94704";
/** Cycle culprit — exports `oe`/`re` lazily; populated by `wreq.t`. */
const MOD_CYCLE_HELPER = "33488";
/** SPA React-app top-level — hosts the source-patched closure-private decls. */
const MOD_SPA_TOPLEVEL = "10409";

/** Modules the shimmed wreq detours through fresh factory calls. */
const REWIRE_IDS: ReadonlySet<string> = new Set([MOD_CHAT_STORE, MOD_CYCLE_HELPER]);

// ─── Helpers ─────────────────────────────────────────────────────────────

type ChatWreq = ((id: string) => unknown) & { m: Record<string, Function> };

/**
 * Build a wreq proxy that detours `REWIRE_IDS` modules to a fresh
 * `module`/`exports` factory call (using a per-module reentry guard so
 * cycles serve the cached value on the inner reference). Other ids
 * pass through to the real wreq so cached state stays consistent.
 */
function makeShimmedWreq(real: ChatWreq): ChatWreq {
  const reentry = new Set<string>();
  const shimmed = Object.assign(
    (id: string): unknown => {
      if (!REWIRE_IDS.has(id) || reentry.has(id)) return real(id);
      const fac = real.m?.[id];
      if (typeof fac !== "function") return real(id);
      const fakeMod = { exports: {} as Record<string, unknown> };
      reentry.add(id);
      try {
        fac.call(fakeMod.exports, fakeMod, fakeMod.exports, shimmed);
      } catch {
        // tolerated — partial exports still go back via `module.exports`
      }
      reentry.delete(id);
      return fakeMod.exports;
    },
    // Copy every property off the real wreq (m, d, r, t, n, p, s, …).
    // Required for the factory body to use webpack's runtime helpers
    // (e.g. `n.d(t, {...})` for export definition).
    real as unknown as Record<string, unknown>,
  ) as unknown as ChatWreq;
  return shimmed;
}

// ─── primeModule10409 ────────────────────────────────────────────────────
//
// Several closure-private symbols inside module 10409 are exposed to
// `globalThis` by the chat-bundle source-patch (see `auth/chat-bundle.ts`):
//
//   - `__SNAPCAP_HY` — `SearchRequest` ts-proto codec (used by search)
//   - `__SNAPCAP_JY` — `SearchResponse` ts-proto codec (used by search)
//   - `__SNAPCAP_JZ` — `jz` FriendAction client (used by friending)
//
// The patches are byte-correct, but they only fire when module 10409's
// factory body actually executes. In our headless realm the SPA's
// Promise-driven module load can throw partway. We re-run 10409 through
// the shimmed wreq above until any of the expected globals land.

/**
 * True if any of module 10409's source-patched globals have landed.
 *
 * We deliberately accept ANY of the three as proof of priming, because
 * `HY` / `jY` / `jz` are all declared inside the same module 10409
 * factory body — once one lands, the others land in the same execution.
 * `__SNAPCAP_JZ` is the most reliable presence check on its own, but in
 * practice we want the helper to be cheap to call from any code path.
 */
function isModule10409Primed(): boolean {
  const sb = getSandbox();
  if (sb.getGlobal("__SNAPCAP_JZ")) return true;
  if (sb.getGlobal("__SNAPCAP_HY")) return true;
  if (sb.getGlobal("__SNAPCAP_JY")) return true;
  return false;
}

/**
 * Re-run module 10409's factory through a shimmed wreq until one of
 * `__SNAPCAP_HY` / `__SNAPCAP_JY` / `__SNAPCAP_JZ` lands. Idempotent —
 * if any are already present, returns immediately.
 *
 * 20 attempts is generous; in practice the globals land on the first
 * or second try once the shimmed wreq is in place. Each attempt yields
 * to the event loop so any pending sandbox-side microtasks (module
 * eval continuations, Promise resolutions in sibling modules) get a
 * chance to run.
 */
export async function primeModule10409(): Promise<void> {
  if (isModule10409Primed()) return;

  const wreq = chatWreq();
  const shimmed = makeShimmedWreq(wreq);
  // Pre-rewire 94704 + 33488 to fresh factories now so 10409's first
  // attempt sees them via the shim.
  try { shimmed(MOD_CYCLE_HELPER); } catch { /* tolerated */ }
  try { shimmed(MOD_CHAT_STORE); } catch { /* tolerated */ }

  const factory = wreq.m?.[MOD_SPA_TOPLEVEL];
  for (let i = 0; i < 20 && !isModule10409Primed(); i++) {
    if (typeof factory === "function") {
      const fakeModule = { exports: {} as Record<string, unknown> };
      try {
        factory.call(fakeModule.exports, fakeModule, fakeModule.exports, shimmed);
      } catch {
        // tolerated — globals may execute before any throw
      }
    } else {
      try { wreq(MOD_SPA_TOPLEVEL); } catch { /* tolerated */ }
    }
    if (isModule10409Primed()) break;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

// ─── primeAuthStoreModule ────────────────────────────────────────────────
//
// Module 94704 (the Zustand chat store) has the same factory-time cyclic
// dep with 33488. After bundle bring-up its real-wreq cache may hold an
// empty/partial entry. Force-eval 33488 (cycle culprit) so its `oe`/`re`
// exports populate the real cache, then re-eval 94704 through the shim
// until `M.getState` is callable.

/**
 * Re-run module 94704's factory through a shimmed wreq that bypasses the
 * webpack cache for 94704 + 33488. Same mechanism as `primeModule10409`.
 * Idempotent — bails out as soon as `M.getState` is callable.
 */
export async function primeAuthStoreModule(): Promise<void> {
  const wreq = chatWreq();
  // Cheap probe first.
  try {
    const m = wreq(MOD_CHAT_STORE) as { M?: { getState?: Function } };
    if (m?.M?.getState) return;
  } catch {
    // fall through to shimmed re-eval
  }
  const shimmed = makeShimmedWreq(wreq);
  // Force-eval 33488 (cycle culprit) so its `oe`/`re` exports populate
  // the real cache before 94704's body asks for them.
  try { wreq(MOD_CYCLE_HELPER); } catch { /* tolerated */ }
  try { shimmed(MOD_CYCLE_HELPER); } catch { /* tolerated */ }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const m = shimmed(MOD_CHAT_STORE) as { M?: { getState?: Function } };
      if (m?.M?.getState) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  // Final attempt — if it still fails, downstream code will surface a
  // clean "shape shifted" error from `authSlice()`.
}
