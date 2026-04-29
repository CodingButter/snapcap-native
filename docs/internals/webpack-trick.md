# The webpack runtime patch

To run Snap's bundle from Node, we have to call into individual webpack modules by id. That sounds simple — webpack has a `__webpack_require__` function that does exactly that. The problem is that in any modern webpack build, `__webpack_require__` lives inside an IIFE closure and never escapes to globalThis. Snap's runtime is no exception.

This chapter is the story of how we coax it out.

## What "loading the bundle" actually means

When the browser loads `webpack-…js`, the first thing that runs is an IIFE that defines `p` (the require function) and a chunk-array hook:

```js
!function(){
  "use strict";
  var e, c, t, f, a, n, r, d, b, o, u, i, s = {}, l = {};

  function p(e) {
    var c = l[e];
    if (void 0 !== c) return c.exports;
    var t = l[e] = { id: e, loaded: !1, exports: {} };
    s[e].call(t.exports, t, t.exports, p);
    return t.loaded = !0, t.exports;
  }
  p.m = s;
  p.amdO = {};
  // … 100 more p.X = … definitions …

  u = function (e, c) {
    var t, f, a = c[0], n = c[1], r = c[2], d = 0;
    if (a.some(function (e) { return 0 !== o[e] })) {
      for (t in n) p.o(n, t) && (p.m[t] = n[t]);   // ← installs modules
      if (r) var b = r(p);                          // ← runs runtime fn
    }
    for (e && e(c); d < a.length; d++)
      f = a[d], p.o(o, f) && o[f] && o[f][0](),
      o[f] = 0;
    return p.O(b);
  };

  (i = self.webpackChunk_N_E = self.webpackChunk_N_E || []).forEach(u.bind(null, 0));
  i.push = u.bind(null, i.push.bind(i));
}();
```

Two things to notice:

1. `p` is the require function. It is **never assigned to anything outside this IIFE**. Once the IIFE finishes executing, the only way to call `p` is if you got a reference to it from inside. There's no `globalThis.p`, no `module.exports.p`, no `window.__webpack_require__`.
2. The chunk array `webpackChunk_N_E` is the only escape hatch. Other bundle files push entries onto it, and `u` (the chunk processor) consumes them — installing modules into `p.m` and calling any chunk-runtime function `c[2]` with `p` as the argument.

So if we want to call `p` from outside, we either need to be inside that IIFE, or we need to be inside a chunk-runtime function that the IIFE calls.

## The first attempt: hook the chunk push

The natural-looking first move is to pre-create `webpackChunk_N_E` with a hooked `push`:

```ts
const arr: unknown[] = [];
arr.push = function snapcapPush(...chunks: unknown[]): number {
  for (const chunk of chunks) {
    const runtimeFn = chunk[2];
    if (typeof runtimeFn === "function") {
      chunk[2] = function (p: unknown) {
        // Capture p as it's about to be passed in.
        globalThis.__snapcap_p = p;
        return runtimeFn(p);
      };
    }
  }
  return Array.prototype.push.apply(this, chunks);
};
globalThis.webpackChunk_N_E = arr;
```

Sound reasonable? It doesn't work. Here's the order of events when the bundle loads:

1. We pre-create the array with our hooked push. `webpackChunk_N_E.push === ourHook`.
2. Some chunks get pushed. Our hook runs, wraps their `c[2]` (if any), and stores them in the array.
3. The webpack runtime IIFE evaluates. It does `i = self.webpackChunk_N_E` (our array), then:
   ```js
   i.push = u.bind(null, i.push.bind(i));
   ```
4. `i.push.bind(i)` evaluates **first**, capturing our hook. Then `u.bind(null, ourHook)` builds the new push. `i.push` is now `(c) => u(ourHook, c)`.
5. From this point on, every chunk push goes through `u` first. Inside `u`:
   ```js
   for (t in n) p.o(n, t) && (p.m[t] = n[t]);   // copies UNWRAPPED factories
   if (r) var b = r(p);                          // calls UNWRAPPED chunk[2]
   for (e && e(c); …)                            // ← only NOW does our hook run
   ```

By the time our hook fires, `u` has already done the work using the original `chunk[2]`. The wrap we install is too late.

## The fix: source-patch the runtime

The cleanest workaround is to rewrite one line of the webpack runtime before evaluating it. The line:

```js
p.m = s, p.amdO = {}, …
```

becomes:

```js
globalThis.__snapcap_p = p, p.m = s, p.amdO = {}, …
```

That single comma-expression assignment leaks `p` to globalThis as a side-effect of the runtime's normal initialization. By the time any chunks are pushed, we already have `p` in hand.

The full patch in `bootKameleon`:

```ts
if (file.startsWith("webpack-")) {
  src = src.replace("p.m=s,p.amdO={}", "globalThis.__snapcap_p=p,p.m=s,p.amdO={}");
}
new Function("module", "exports", "require", src)({ exports: {} }, {}, () => {
  throw new Error("require not available");
});
```

After this runs, `globalThis.__snapcap_p` is the real `__webpack_require__` — `globalThis` here is the **sandbox-realm** global, not the host's. The bundle is eval'd via `sandbox.runInContext(src)` (see [the sandbox chapter](/internals/sandbox)), so `globalThis.__snapcap_p=p,…` lands on the vm.Context's global. SDK code reads it back via `getSandbox().getGlobal("__snapcap_p")`. Then we call `wreq("58116")` and get the kameleon Module factory. Done.

Why this is durable:

- The pattern `p.m=s,p.amdO={}` is generated by webpack's own runtime template. It's stable across minor webpack versions because `p.m` is the canonical "module dict" name and `p.amdO` is the AMD detection bag — both are runtime invariants, not user code.
- The patch is a single string replace. If Snap rebuilds the bundle and the file hash changes, the patch survives. If they rename `p` (vanishingly unlikely — the minifier picks `p` based on alphabetical order of identifiers), we'd see a clear failure when `__snapcap_p` is undefined and we'd fix it in five minutes.
- The patch doesn't change behavior. It just exports a reference. Snap's anti-fraud doesn't see anything: it doesn't fingerprint the runtime IIFE.

## Capturing factories anyway

Even with `__snapcap_p` in hand, we still want to know which webpack modules contain what. The `webpack-capture.ts` shim wraps every factory at push time:

```ts
function wrapFactories(modulesObj: Record<string, unknown>): void {
  for (const id in modulesObj) {
    const factory = modulesObj[id];
    if (typeof factory !== "function") continue;
    const stamp = `m${originals.size}#${id}`;
    originals.set(stamp, factory as Function);  // keep the original for source-grep
    modulesObj[id] = function wrapped(module, exports, require) {
      try {
        return (factory as Function)(module, exports, require);
      } finally {
        modules.set(id, module.exports);          // capture exports after run
      }
    };
  }
}
```

The `originals` Map is the secret weapon for spelunking. When you grep across factories' source code (e.g., for `"SyncFriendData"`), you have to scan `originals`, not `modules` — because `modules` holds the *exports* of each factory, and the exports lose all of the source string information that's only present in the factory body.

## Cross-bundle module collision

Snap ships the bundle as multiple webpack chunks loaded from different hosts:

- `static.snapchat.com/accounts/_next/static/chunks/*.js` — the accounts bundle (login, password, signup, etc.)
- `cf-st.sc-cdn.net/dw/*.js` — the chat bundle (AtlasGw, MessagingCore, presence)

Each bundle uses its own webpack chunk-array name (`webpackChunk_N_E` vs `webpackChunk_snapchat_web_calling_app`) and its own webpack runtime. Module IDs are scoped per-bundle: module 74052 in the chat bundle is AtlasGw; module 74052 in the accounts bundle is something completely different (if it exists at all).

When we boot kameleon, only the accounts bundle is loaded. The first time anything calls `listFriends()`, `api/friends.ts` lazy-loads the chat bundle and merges its factories into the accounts `p.m`. As above, `globalThis` here is the sandbox-realm global — both chunk arrays live in the vm.Context, not the host:

```ts
const arr = sandbox.getGlobal<unknown[]>("webpackChunk_snapchat_web_calling_app")!;
for (const chunk of arr) {
  const mods = chunk[1] as Record<string, Function>;
  for (const id in mods) {
    wreq.m[id] = mods[id];   // chat-id wins on collision; we're calling chat's API
  }
}
```

Collisions are theoretical — the only IDs we actually call belong to the AtlasGw client and its protobuf types, which are chat-bundle-only — but the merge logic does override on overlap, so chat's view of an id is what the SDK sees afterward.

## What this gives us

After both bundles are loaded:

- `wreq("58116")` → kameleon Emscripten Module factory (accounts)
- `wreq("13150")` → WebLoginService gRPC client + descriptors (accounts)
- `wreq("29517")` → WebLoginRequest / WebLoginResponse codecs (accounts)
- `wreq("17231")` → ~600 protobuf definitions covering the entire Janus auth schema (accounts)
- `wreq("40243")` → UAParser (accounts)
- `wreq("94631")` → WebAttestationServiceClient (accounts)
- `wreq("74052")` → AtlasGw client + every AtlasGw method descriptor (chat)

That's the entire auth + social-graph API surface, by id, available from a Node `require`-shaped function we built ourselves. No proto files. No codegen. No reverse engineering past the initial mapping.
