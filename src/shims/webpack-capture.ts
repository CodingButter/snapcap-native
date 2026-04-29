/**
 * Hook Snap's webpack chunk array so every module factory captures its
 * exports into a global `__snapcap_modules` Map keyed by module id.
 *
 * Snap's bundle pushes chunks onto a global named `webpackChunk_N_E` (or
 * similar). Each chunk is `[chunkIds, modules, runtime?]` where `modules`
 * is an `{ [id]: factory }` object. Wrapping the factories at push time
 * lets us capture every module's exports as the page bootstraps.
 */

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

export function installWebpackCapture(): {
  modules: CapturedModules;
  originals: OriginalFactories;
  hints: ModuleHint[];
} {
  const g = globalThis as unknown as {
    __snapcap_modules?: CapturedModules;
    __snapcap_original_factories?: OriginalFactories;
    __snapcap_module_hints?: ModuleHint[];
  };
  if (
    g.__snapcap_modules &&
    g.__snapcap_module_hints &&
    g.__snapcap_original_factories
  ) {
    return {
      modules: g.__snapcap_modules,
      originals: g.__snapcap_original_factories,
      hints: g.__snapcap_module_hints,
    };
  }
  const modules: CapturedModules = new Map();
  const originals: OriginalFactories = new Map();
  const hints: ModuleHint[] = [];
  g.__snapcap_modules = modules;
  g.__snapcap_original_factories = originals;
  g.__snapcap_module_hints = hints;

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
      // Stash the original so source scans can find string literals that
      // would otherwise be trapped inside the wrap closure. Prefix with a
      // unique counter so factories from different chunk arrays don't
      // overwrite each other on collision.
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
    // chunk[2] is the optional runtime function. Webpack calls it with `p`,
    // its require/modules bag. By wrapping it we capture `p` for later use.
    if (chunk.length >= 3 && typeof chunk[2] === "function") {
      const origRuntime = chunk[2] as (p: unknown) => unknown;
      if (!(origRuntime as { __snapcap_runtime_wrapped?: boolean }).__snapcap_runtime_wrapped) {
        const wrappedRuntime = function (p: unknown): unknown {
          try {
            const w = globalThis as unknown as {
              __snapcap_webpack_p?: unknown;
            };
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
    // Process anything pushed before we got here.
    for (const chunk of arr) processChunk(chunk);

    // Wrap push so we get a chance to capture chunk[2] (the runtime function)
    // before webpack runs it with `p` (the require/module-dict bag). That
    // captured `p` lets us iterate `p.m` (all webpack modules) and force-load
    // them post-bootstrap, sidestepping the copy-before-wrap race that
    // otherwise prevents factory wrapping from sticking.
    const origPush = arr.push.bind(arr);
    arr.push = function snapcapPush(...chunks: unknown[]): number {
      for (const c of chunks) processChunk(c);
      return origPush(...chunks);
    };
  }

  // Pre-create the chunk array WITH our hooked push, so when the bundle
  // does `self.webpackChunk_N_E = self.webpackChunk_N_E || []` it uses our
  // already-hooked array and we capture every chunk push from the start.
  //
  // The chunk-array name ("webpackChunk_N_E") is defined by Next.js at build
  // time. For Snap's accounts bundle it's "webpackChunk_N_E"; the chat
  // client at cf-st.sc-cdn.net may use a different name. We pre-create
  // both common variants — extras are harmless.
  const w = globalThis as unknown as Record<string, unknown>;
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

  // Also handle the case where the bundle has ALREADY registered (e.g.,
  // load-after-bootstrap test scenarios) — hook any existing arrays we missed.
  for (const k of Object.keys(w)) {
    if (k.startsWith("webpackChunk") && Array.isArray(w[k])) {
      // Detect whether we've already hooked this one by checking property
      // descriptor: our get/set form sets configurable+get+set but no value.
      const desc = Object.getOwnPropertyDescriptor(w[k], "push");
      if (desc && desc.get) continue;
      hookChunkArray(w[k] as unknown[]);
    }
  }

  return { modules, originals, hints };
}
