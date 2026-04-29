# Sandbox

Most consumers don't need this page. The sandbox is the isolated `vm.Context` that runs Snap's bundle JS + WASM with happy-dom-shaped browser globals projected onto it. `SnapcapClient` boots and manages it for you.

Surfaced for: callers that want to eval extra bundle source, introspect bundle-registered artefacts (Module objects, webpack maps), or share the same sandbox with their own bundle interop code.

See [Internals → Architecture](/internals/architecture) and [The webpack trick](/internals/webpack-trick) for the long-form story.

## installShims

```ts
function installShims(opts?: InstallShimOpts): Sandbox
```

```ts
type InstallShimOpts = SandboxOpts;
```

Construct (or return) the singleton `Sandbox`. **First-call-wins** — subsequent calls return the existing sandbox regardless of `opts`. `SnapcapClient`'s constructor already calls this with the right DataStore, so you only need it if you're building bundle interop *without* a `SnapcapClient`.

```ts
import { installShims, FileDataStore } from "@snapcap/native";

const sandbox = installShims({
  url: "https://www.snapchat.com/web",
  dataStore: new FileDataStore("./auth.json"),
});
```

## getSandbox

```ts
function getSandbox(): Sandbox
```

Read the singleton sandbox. **Throws** if `installShims()` hasn't been called yet.

## isShimInstalled

```ts
function isShimInstalled(): boolean
```

Probe whether `installShims()` has run. Useful for libraries that want to set up the sandbox themselves only if no one else has.

## Sandbox

```ts
class Sandbox {
  readonly window: Record<string, unknown>;
  readonly context: vm.Context;
  constructor(opts?: SandboxOpts);
  runInContext(source: string, filename?: string): unknown;
  getGlobal<T = unknown>(key: string): T | undefined;
  setGlobal(key: string, value: unknown): void;
  toVmU8(bytes: Uint8Array | ArrayBufferView): Uint8Array;
  get document(): unknown;
}
```

```ts
type SandboxOpts = {
  /** Page URL the Window pretends to be on. Default www.snapchat.com/web. */
  url?: string;
  /** UA string. Default Mac Chrome 147 fingerprint. */
  userAgent?: string;
  /** Width of the (virtual) viewport. Default 1440. */
  viewportWidth?: number;
  /** Height of the (virtual) viewport. Default 900. */
  viewportHeight?: number;
  /** Persistent backing for localStorage / sessionStorage / indexedDB / cookie. */
  dataStore?: DataStore;
};
```

The constructor builds an isolated `vm.Context`, projects every defined own-property of a happy-dom `Window` onto its global, layers Snap-bundle stubs (`chrome`, `requestIdleCallback`, `caches`, `importScripts`) on top, and (if `dataStore` is supplied) replaces happy-dom's default Storage / IndexedDB / cookie implementations with DataStore-backed shims.

Bundle code eval'd via `runInContext` sees that synthesized global as its `globalThis` / `self` / `window`.

### runInContext

```ts
runInContext(source: string, filename?: string): unknown
```

Evaluate JavaScript in the sandbox. The code's `globalThis`, bare global references (`localStorage`, `document`, etc.), and top-level `this` all resolve to the synthesized vm global.

```ts
const sandbox = getSandbox();
sandbox.runInContext("globalThis.__snapcap_marker = 42", "<my-injection>");
console.log(sandbox.getGlobal("__snapcap_marker"));   // 42
```

### getGlobal

```ts
getGlobal<T = unknown>(key: string): T | undefined
```

Read a property from the sandbox global. Useful for picking up bundle-registered artefacts (e.g. the webpack map at `__snapcap_p`, kameleon's `Module`, etc.).

### setGlobal

```ts
setGlobal(key: string, value: unknown): void
```

Set a property on the sandbox global. Useful for pre-staging values the bundle's eval needs to find at the top level.

### toVmU8

```ts
toVmU8(bytes: Uint8Array | ArrayBufferView): Uint8Array
```

Copy bytes into a vm-realm `Uint8Array` so bundle code recognises it as a "real" `Uint8Array`. Cross-realm `instanceof Uint8Array` fails — each `vm` context has its own typed-array constructors — and bundle protobuf decoders throw `Error("illegal buffer")` on a foreign view.

Use this any time SDK (host-realm) code hands raw bytes into a bundle function: gRPC response decode, Embind argument marshalling, custom proto round-trips through bundle decoders.

```ts
const sandbox = getSandbox();
const vmBytes = sandbox.toVmU8(hostBytes);
const decoded = sandbox.runInContext("(b) => SomeBundleProto.decode(b)")(vmBytes);
```

### document

```ts
get document: unknown
```

The happy-dom `Document` instance. For direct DOM mutation (e.g. injecting a `#root` div before React mounts during a bundle's top-level eval). Most consumers never touch this.

## window

```ts
readonly window: Record<string, unknown>
```

The synthesized vm-realm global. This is what bundle code sees as `globalThis`. Read/write the same surface as `getGlobal` / `setGlobal` if you prefer a property-access style.

## context

```ts
readonly context: vm.Context
```

The raw Node `vm.Context`. Pass to `vm.runInContext(src, ctx)` directly if you need to bypass the `runInContext` helper for some reason (e.g. supplying a custom `vm.RunningScriptOptions`).
