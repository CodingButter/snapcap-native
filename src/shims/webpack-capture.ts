/**
 * Hook Snap's webpack chunk array so every module factory captures its
 * exports into a Map keyed by module id.
 *
 * Snap's bundle pushes chunks onto a global named `webpackChunk_N_E` (or
 * similar). Each chunk is `[chunkIds, modules, runtime?]` where `modules`
 * is an `{ [id]: factory }` object. Wrapping the factories at push time
 * lets us capture every module's exports as the page bootstraps.
 *
 * Storage:
 *   - The chunk arrays themselves live on `sandbox.window` so the bundle
 *     (running under `sandbox.runInContext`) sees them as `self.webpackChunk_*`.
 *   - The capture maps (modules / originals / hints) are module-private
 *     here so multiple sandboxed bundles share the same accumulator
 *     without polluting the sandbox's namespace.
 */
import { getSandbox } from "./runtime.ts";

const HINT_PATTERNS = [
  /CreateContentMessage|sendMessage|sendChat/i,
  /SyncFriendData|fetchFriends|friendList|getFriends/i,
  /addFriend|friendRequest|sendFriendRequest/i,
  /viewSnap|openSnap|markViewed/i,
  /uploadMedia|getUploadLocation/i,
  /Fidelius/i,
];

export type CapturedModules = Map<string, unknown>;
export type OriginalFactories = Map<string, Function>;

export type ModuleHint = {
  moduleId: string;
  hint: string;
  keys: string[];
};

let installed: {
  modules: CapturedModules;
  originals: OriginalFactories;
  hints: ModuleHint[];
} | null = null;

export function installWebpackCapture(): {
  modules: CapturedModules;
  originals: OriginalFactories;
  hints: ModuleHint[];
} {
  if (installed) return installed;

  const sandbox = getSandbox();
  const w = sandbox.window as unknown as Record<string, unknown>;

  const modules: CapturedModules = new Map();
  const originals: OriginalFactories = new Map();
  const hints: ModuleHint[] = [];

  function detectHint(exp: unknown): string | null {
    if (!exp || typeof exp !== "object") return null;
    let keys: string[] = [];
    try {
      keys = Object.keys(exp as object);
    } catch {
      return null;
    }
    for (const k of keys) {
      for (const re of HINT_PATTERNS) {
        if (re.test(k)) return k;
      }
    }
    return null;
  }

  function wrapFactories(modulesObj: Record<string, unknown>): void {
    for (const id in modulesObj) {
      const factory = modulesObj[id];
      if (
        typeof factory !== "function" ||
        (factory as { __snapcap_wrapped?: boolean }).__snapcap_wrapped
      ) {
        continue;
      }
      const stamp = `m${originals.size}#${id}`;
      originals.set(stamp, factory as Function);
      const wrapped = function (
        module: { exports: unknown },
        exports: unknown,
        require: unknown,
      ): unknown {
        try {
          return (factory as (m: unknown, e: unknown, r: unknown) => unknown)(
            module,
            exports,
            require,
          );
        } finally {
          try {
            const exp = module.exports;
            modules.set(id, exp);
            const hint = detectHint(exp);
            if (hint) {
              hints.push({
                moduleId: id,
                hint,
                keys:
                  exp && typeof exp === "object"
                    ? Object.keys(exp as object)
                    : [],
              });
            }
          } catch {
            /* tolerate */
          }
        }
      };
      (wrapped as { __snapcap_wrapped?: boolean }).__snapcap_wrapped = true;
      modulesObj[id] = wrapped;
    }
  }

  function processChunk(chunk: unknown): void {
    if (!Array.isArray(chunk) || chunk.length < 2) return;
    const modulesObj = chunk[1];
    if (modulesObj && typeof modulesObj === "object") {
      wrapFactories(modulesObj as Record<string, unknown>);
    }
    if (chunk.length >= 3 && typeof chunk[2] === "function") {
      const origRuntime = chunk[2] as (p: unknown) => unknown;
      if (!(origRuntime as { __snapcap_runtime_wrapped?: boolean }).__snapcap_runtime_wrapped) {
        const wrappedRuntime = function (p: unknown): unknown {
          try {
            if (!w.__snapcap_webpack_p) {
              w.__snapcap_webpack_p = p;
            }
          } catch {
            /* tolerate */
          }
          return origRuntime(p);
        };
        (wrappedRuntime as { __snapcap_runtime_wrapped?: boolean }).__snapcap_runtime_wrapped =
          true;
        chunk[2] = wrappedRuntime;
      }
    }
  }

  function hookChunkArray(arr: unknown[]): void {
    for (const chunk of arr) processChunk(chunk);
    const origPush = arr.push.bind(arr);
    arr.push = function snapcapPush(...chunks: unknown[]): number {
      for (const c of chunks) processChunk(c);
      return origPush(...chunks);
    };
  }

  // Pre-create the chunk array on the sandbox Window WITH our hooked push,
  // so when the bundle does `self.webpackChunk_N_E = self.webpackChunk_N_E || []`
  // it uses our already-hooked array and we capture every chunk push from
  // the start.
  //
  // The chunk-array name is defined by the bundle at build time. Pre-create
  // every variant we know about — extras are harmless.
  const KNOWN_NAMES = [
    "webpackChunk_N_E",
    "webpackChunk_snapchat_web_calling_app",
    "webpackChunk",
    "webpackJsonp",
  ];
  for (const name of KNOWN_NAMES) {
    if (!w[name]) {
      const arr: unknown[] = [];
      hookChunkArray(arr);
      w[name] = arr;
    }
  }

  // Also handle the case where the bundle has ALREADY registered an array
  // we missed — hook anything pre-existing.
  for (const k of Object.keys(w)) {
    if (k.startsWith("webpackChunk") && Array.isArray(w[k])) {
      const desc = Object.getOwnPropertyDescriptor(w[k], "push");
      if (desc && desc.get) continue;
      hookChunkArray(w[k] as unknown[]);
    }
  }

  installed = { modules, originals, hints };
  return installed;
}
