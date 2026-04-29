# The sandbox isolation model

Snap's bundle is browser code. To run it from Node we have to give it a `globalThis` shaped like a Window — `document`, `navigator`, `localStorage`, `fetch`, `crypto`, `Element`, the lot. The naive way to do that is to import [happy-dom](https://github.com/capricorn86/happy-dom)'s `GlobalRegistrator` and let it install its Window properties straight onto Node's `globalThis`. The first cut of snapcap did exactly that. It worked, and it was wrong.

This chapter explains what we replaced it with and why.

## Why GlobalRegistrator had to go

GlobalRegistrator mutates the consumer's process. Once you import a Snap-bundle-loading module, the host's `globalThis.fetch`, `globalThis.localStorage`, `globalThis.document` are all happy-dom shims. `fetch("https://example.com")` from anywhere in your app suddenly goes through happy-dom's URL/cookie/redirect handling. `Math` is fine, `Promise` is fine, but anything browser-shaped is not the standard library you imported expects.

For a public SDK that ships as `@snapcap/native`, that's a non-starter. Consumers would have observability for nothing they did themselves.

## The vm.Context approach

`src/shims/sandbox.ts` constructs an isolated Node `vm.Context` and projects happy-dom's Window properties onto *its* global, not the host's. Snap's bundle and Fidelius WASM run via `sandbox.runInContext(src)` and see that synthesized global as `globalThis` / `window` / `self`. The host realm's `globalThis` is never touched.

The trick is the construction order:

```ts
// src/shims/sandbox.ts:83-95
this.hdWindow = new Window({ url, width, height, settings: { navigator: { userAgent } } });

// Empty sandbox object → V8 fills the new context's global with built-ins
// (Object, Array, Promise, WebAssembly, JSON, …) before any of our own
// properties land.
this.context = vm.createContext({});
const ctxGlobal = vm.runInContext("globalThis", this.context);
this.window = ctxGlobal;
```

Two halves:

1. **Empty sandbox first** so V8 fills the new realm with `Object`, `Array`, `Promise`, `WebAssembly`, `JSON`, the typed-array constructors, etc. These are the *vm-realm* built-ins, not the host's.
2. **Project happy-dom Window own-props** onto that global afterwards.

If you instead pass the happy-dom Window directly into `vm.createContext(hdWindow)`, V8 sees an existing object and won't install built-ins on top of it. happy-dom's Window has `Object`/`Array`/`Promise` defined as `undefined` instance stubs (it's designed to be installed via GlobalRegistrator, which works because the host already has them). Using it as the context object means those `undefined` stubs *replace* V8's built-ins. The bundle then hits `new Promise(...)` and throws `Promise is not a constructor` immediately.

Doing it in two steps gives us V8's built-ins first, happy-dom's browser-side properties layered on top.

## Project everything, not a curated list

The original implementation enumerated browser-API keys and copied them by name. That's a trap. A curated list silently leaves out things the WASM expects. When the bundle's React code does `requestAnimationFrame(...)` and gets `undefined`, it Promise-chains a callback that never resolves; the kameleon WASM coroutine ends up busy-looping on `emscripten_get_now` at ~10M calls/sec. There is no thrown error, no log line — just CPU pegged and the test timing out.

The fix is to copy *every* defined own-property of happy-dom's Window:

```ts
// src/shims/sandbox.ts:106-115
for (const key of Object.getOwnPropertyNames(hd)) {
  if (key in ctxGlobal) continue; // don't shadow built-ins V8 already provided
  const v = hd[key];
  if (v === undefined || v === null) continue;
  try { ctxGlobal[key] = v; } catch { /* non-configurable — skip */ }
}
```

Two safety rails:

- `if (key in ctxGlobal) continue` — V8's built-ins (Object/Array/Promise/etc.) win. happy-dom's `undefined` instance stubs are skipped.
- `if (v === undefined || v === null) continue` — second-line defense. Even if a built-in happens to not be on the vm global at this point, an `undefined` stub from happy-dom never lands.

`BROWSER_PROJECTED_KEYS` (`src/shims/sandbox.ts:44-66`) survives only as documentation of which keys we explicitly *expect* to be present. The actual installation is the loop above.

## DataStore-backed shims, layered on top

After projection, if a `DataStore` was passed in `SandboxOpts`, four browser-storage APIs get overridden with DataStore-backed implementations:

```ts
// src/shims/sandbox.ts:128-141
if (opts.dataStore) {
  ctxGlobal.localStorage   = new StorageShim(opts.dataStore, "local_");
  ctxGlobal.sessionStorage = new StorageShim(opts.dataStore, "session_");
  ctxGlobal.indexedDB      = new IDBFactoryShim(opts.dataStore);
  installDocumentCookieShim(this, opts.dataStore);
}
```

If no DataStore is passed, happy-dom's in-memory defaults apply (the projection step copied them). That's fine for one-shot scripts but loses every browser-storage write between processes.

The DataStore-backed forms route every Web Storage / IndexedDB / `document.cookie` read and write through the SDK's persistence layer. See [the persistence chapter](/internals/persistence) for the full key map.

## Snap-bundle-specific stubs

A handful of globals the bundle expects are not browser API — they're Chrome / web-worker conventions. Sandbox installs minimal stubs for them after projection:

- `chrome.runtime` / `chrome.app` / `chrome.csi` / `chrome.loadTimes` — feature-detection points only; never read back
- `requestIdleCallback` / `cancelIdleCallback` — backed by `setTimeout`
- `importScripts` — no-op (worker-only API)
- `caches` — empty `CacheStorage` shim returning empty results

`window` / `self` / `top` / `parent` / `frames` are aliased to the same global so bundle code that does `self.webpackChunk_*`, `window.foo`, and `globalThis.bar` interchangeably all hits the same object.

## Cross-realm Uint8Array

The vm context has its own typed-array constructors. Bundle protobuf decoders run in the vm realm and check `instanceof Uint8Array` against *their* `Uint8Array`. A `Uint8Array` constructed in the host realm fails that check and the decoder throws:

```
Error: illegal buffer
    at Reader.create (protobufjs/src/reader.js:...)
```

Anywhere SDK code passes raw bytes into bundle code — gRPC response decode, Embind argument marshalling, login-response parsing — bytes have to be copied into a vm-realm Uint8Array first:

```ts
// src/shims/sandbox.ts:206-214
toVmU8(bytes: Uint8Array | ArrayBufferView): Uint8Array {
  const VmU8 = this.runInContext("Uint8Array") as Uint8ArrayConstructor;
  const out = new VmU8(bytes.byteLength);
  out.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return out;
}
```

Two callers today:

- `src/auth/login.ts:175` — wrapping the WebLogin response payload before handing it to the bundle's protobuf decoder.
- `src/transport/grpc-web.ts:144` — wrapping every AtlasGw / MessagingCore response body before `decode` / `deserializeBinary`.

If you write a new path that hands bytes into the bundle, run it through `getSandbox().toVmU8(...)`.

## Bundle source wrapping

`runInContext(src)` evaluates `src` directly as if it were the top of a script. Snap's bundles are emitted by webpack as IIFEs, but their last byte is a `//# sourceMappingURL=…` line comment with no trailing newline:

```js
…
}();
//# sourceMappingURL=https://…
```

If the SDK appends its own `})(…)` continuation to invoke a wrapping IIFE without a newline, the line comment swallows it. The bundle never runs.

The fix is unglamorous: wrap with explicit newlines.

```ts
// pseudo, see auth/chat-bundle.ts and auth/kameleon.ts for the real callsites
const wrapped = "(function(module, exports, require) {\n" + src + "\n})(...)";
sandbox.runInContext(wrapped, "snap-bundle.js");
```

The leading `\n` is defensive (some chunk files start with `//#` source-map comments too). The trailing `\n` is the load-bearing one.

## Singleton lifecycle

`src/shims/runtime.ts` exposes `installShims(opts)` and `getSandbox()`. Both target a process-wide singleton:

```ts
// src/shims/runtime.ts:19-27
export function installShims(opts: InstallShimOpts = {}): Sandbox {
  if (installed) return installed;
  installed = new Sandbox(opts);
  return installed;
}
```

First call wins. `SnapcapClient`'s constructor calls `installShims({ dataStore })` eagerly so the sandbox is seeded with the consumer's DataStore before kameleon or chat-bundle boot — otherwise those flows would call `installShims({})` first and snap-bundle storage writes would land in happy-dom's in-memory defaults instead of the consumer's persistence layer.

## What the consumer sees

From outside, the entire vm.Context is invisible. The consumer's `globalThis` is unmodified. `globalThis.fetch`, `globalThis.localStorage`, `globalThis.document` — all whatever Node provides natively (or `undefined` in Node, which is correct). `transport/native-fetch.ts` snapshots `globalThis.fetch` at module load as defence-in-depth, so the SDK's outbound traffic always uses the host realm's fetch even if a future change ever regresses isolation.

The contract is: import `@snapcap/native`, get a client, use it. Nothing else changes.
