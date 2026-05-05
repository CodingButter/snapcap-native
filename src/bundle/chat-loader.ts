/**
 * Shared loader for Snap's chat bundle (cf-st.sc-cdn.net/dw).
 *
 * The chat bundle runs after the kameleon (accounts) login completes.
 * Its main file (9846a…) is monolithic — registering ~1488 webpack
 * modules — and we patch its source to swap two empty Node-stub modules
 * (91903 and 36675) into working impls before eval, otherwise the
 * top-level init throws a sha256 / fs lookup failure.
 *
 * Idempotent: subsequent calls return immediately.
 *
 * Used by:
 *   - api/friends.ts (AtlasGw class lives in module 74052)
 *   - auth/fidelius-mint.ts (Emscripten Module factory lives in 86818,
 *     plus this loader is what makes module 86818's deps resolve)
 *
 * Eval happens inside the sandbox (`Sandbox.runInContext`) — bundle code's
 * `globalThis` is the sandboxed Window, NOT Node's globalThis.
 */
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "../shims/sandbox.ts";
import { primeModule10409, primeAuthStoreModule } from "./prime.ts";

/**
 * Options for {@link ensureChatBundle} / {@link bootChatWasm}-style
 * loaders.
 *
 * @internal Bundle-layer config; consumers don't construct this.
 */
export type ChatBundleOpts = {
  /** Defaults to vendor/snap-bundle relative to this file. */
  bundleDir?: string;
};

/**
 * Load + prime the chat bundle in `sandbox`. After this resolves, the
 * bundle's exports (`HY`/`JY`/`JZ` codecs, Zustand `chatStore` with
 * `M.getState`, etc.) are reachable via `register.ts` getters.
 *
 * Idempotent — eval'd-state lives on `sandbox.chatBundleLoaded` so a
 * fresh Sandbox boots its own copy of the chat bundle. Two
 * `SnapcapClient` instances each get their own chat bundle eval (and
 * hence their own Zustand store, webpack runtime, Embind classes, etc.).
 *
 * @remarks Includes priming as part of bring-up: priming was previously
 * called separately from the api layer (a layer violation — `api/*`
 * gates through `register.ts` only). Baked in here because
 * `primeModule10409` + `primeAuthStoreModule` are ALWAYS needed after a
 * chat-bundle load (no use case for "load but don't prime"); coupling
 * them eliminates the chance of forgetting and gives api consumers a
 * single-call surface.
 *
 * @internal Bundle-layer loader; called from `auth/*` during
 * authentication bring-up. Public consumers should not invoke directly.
 * @param sandbox - the per-instance {@link Sandbox} that will host the bundle eval
 * @param opts - optional bundle directory override
 * @throws when any `__SNAPCAP_*` source-patch site is missing (Snap
 *   bundle version drift)
 */
export async function ensureChatBundle(sandbox: Sandbox, opts: ChatBundleOpts = {}): Promise<void> {
  if (sandbox.chatBundleLoaded) return;

  const bundleDir = opts.bundleDir ?? defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");

  ensureChatRuntime(sandbox, chatDw);

  // Pre-stage real Buffer + fs onto the sandbox Window so the patched
  // stub modules can hand them out when invoked from main's top-level.
  if (!sandbox.getGlobal("__snapcap_node_buffer")) {
    sandbox.setGlobal("__snapcap_node_buffer", { Buffer });
  }
  if (!sandbox.getGlobal("__snapcap_node_fs")) {
    sandbox.setGlobal("__snapcap_node_fs", fs);
  }

  let mainSrc = readFileSync(join(chatDw, "9846a7958a5f0bee7197.js"), "utf8");
  mainSrc = mainSrc.replace("91903(){}", "91903(e,t){t.Buffer=globalThis.__snapcap_node_buffer.Buffer}");
  mainSrc = mainSrc.replace("36675(){}", "36675(e,t){Object.assign(t,globalThis.__snapcap_node_fs)}");

  // Expose the Emscripten Module instance built by webpack module 86818's
  // factory. The bundle's wasm slice (module 51867's `N(e)`) calls this
  // factory once during top-level init bring-up; the resulting Module is
  // what holds all 74 Embind classes (talkcorev3_AsyncTask, e2ee_E2EEKeyManager,
  // messaging_Session, ...). We need a handle to it so `bootChatWasm` can
  // poll for runtime-init and return it for downstream messaging API calls
  // — without calling the factory ourselves (a second call would re-register
  // every Embind class in the realm and abort with "Cannot register public
  // name 'X' twice").
  //
  // Same `globalThis.__SNAPCAP_X = …` pattern as the other patches above.
  // Inserted at the very top of the factory body so the reference lands
  // before any `_embind_register_class` calls fire and stays stable for
  // the lifetime of the realm.
  if (mainSrc.includes("o=void 0!==(e=e||{})?e:{};o.ready=new Promise(")) {
    // Capture Module reference, AND inject a printErr hook so subsequent
    // Embind calls that abort surface a real diagnostic (Emscripten's
    // default printErr writes to stderr inside happy-dom which is dropped).
    // Only set if the bundle hasn't already installed one.
    mainSrc = mainSrc.replace(
      "o=void 0!==(e=e||{})?e:{};o.ready=new Promise(",
      "o=void 0!==(e=e||{})?e:{};" +
      "globalThis.__SNAPCAP_CHAT_MODULE=o;" +
      "if(!o.printErr)o.printErr=function(s){if(globalThis.__SNAPCAP_WASM_TRACE)console.error('[wasm-err]',s);};" +
      "if(!o.print)o.print=function(s){if(globalThis.__SNAPCAP_WASM_TRACE)console.error('[wasm-out]',s);};" +
      "o.ready=new Promise(",
    );
  } else {
    throw new Error("chat-bundle: Emscripten Module 86818 factory entry source-patch site missing — bundle version may have shifted");
  }

  // Expose closure-private symbols `Fi` (mediaUploadDelegate) and `Ni`
  // (MediaDeliveryService rpc client) from module 76877 to globalThis.
  // `Fi` is what the SPA installs as slot 4 (Comlink-wrapped) of
  // `createMessagingSession`; we install it as slot 3 in our own
  // bring-up. `Ni`'s `rpc.unary` is JS-side gRPC-Web that reads from
  // the SPA Redux store on every request — we swap it post-eval for an
  // unaryCall driven by our `nativeFetch` + cookie jar so the upload
  // pipeline doesn't depend on a populated `auth` slice.
  //
  // The patches use `const X = globalThis.__SNAPCAP_X = …` form so the
  // original binding still resolves inside the module's closure (Fi is
  // referenced directly by `createMessagingSession` further down in the
  // same module body) while we get a callable reference from outside.
  if (mainSrc.includes(";const Fi={uploadMedia:async(e,t,n)=>{")) {
    mainSrc = mainSrc.replace(
      ";const Fi={uploadMedia:async(e,t,n)=>{",
      ";const Fi=globalThis.__SNAPCAP_FI={uploadMedia:async(e,t,n)=>{",
    );
  } else {
    throw new Error("chat-bundle: Fi source-patch site missing — bundle version may have shifted");
  }
  if (mainSrc.includes("const Ni=new class{rpc;constructor(e){")) {
    mainSrc = mainSrc.replace(
      "const Ni=new class{rpc;constructor(e){",
      "const Ni=globalThis.__SNAPCAP_NI=new class{rpc;constructor(e){",
    );
  } else {
    throw new Error("chat-bundle: Ni source-patch site missing — bundle version may have shifted");
  }

  // Expose closure-private symbols `jz` (FriendAction client — `AddFriends`,
  // `RemoveFriends`, etc.), `HY` (SearchRequest ts-proto codec), `jY`
  // (SearchResponse ts-proto codec), and `TY` (SectionType enum) from
  // module 10409 to globalThis. Same pattern as `Fi`/`Ni` above — preserves
  // the original const binding inside the closure (so the rest of the
  // module body still resolves them) while giving us callable references
  // from outside the sandbox.
  //
  // `jz` is the `new class{rpc;...}({unary:(0,Vz.Z)()})` instance the SPA
  // builds at module-init time; it wraps the same `default-authed-fetch`
  // (`Vz.Z`, our module 96789 export `Z`) we'd otherwise reach for
  // ourselves, and its `AddFriends` method calls `rpc.unary(kz, Q$.fromPartial(req))`
  // — i.e. the bundle owns the proto encode end-to-end.
  if (mainSrc.includes("const jz=new class{rpc;")) {
    mainSrc = mainSrc.replace(
      "const jz=new class{rpc;",
      "const jz=globalThis.__SNAPCAP_JZ=new class{rpc;",
    );
  } else {
    throw new Error("chat-bundle: jz source-patch site missing — bundle version may have shifted");
  }
  // `HY`/`jY` are the ts-proto codecs for `SearchRequest` and
  // `SearchResponse`; declared together inside module 10409 (a long
  // `class HY{...} class jY{...}` chain). We replace the bare `class HY`
  // declaration with `class HY` plus a side-effecting assignment that
  // hangs `globalThis.__SNAPCAP_HY = HY` after the class binding lands.
  if (mainSrc.includes(",HY={encode")) {
    mainSrc = mainSrc.replace(",HY={encode", ",HY=globalThis.__SNAPCAP_HY={encode");
  } else {
    throw new Error("chat-bundle: HY source-patch site missing — bundle version may have shifted");
  }
  if (mainSrc.includes(",jY={encode")) {
    mainSrc = mainSrc.replace(",jY={encode", ",jY=globalThis.__SNAPCAP_JY={encode");
  } else {
    throw new Error("chat-bundle: jY source-patch site missing — bundle version may have shifted");
  }

  // Expose closure-private `A` — the AtlasGw client instance constructed at
  // chat main byte ~6940575 as `const A=new a.p$({unary:(0,I.Z)()})`. This
  // is the natural per-bundle AtlasGw instance (methods: SyncFriendData,
  // GetSnapchatterPublicInfo, GetUserIdByUsername, GetFollowers, etc.).
  // Surfacing it lets `atlasClient()` consumers call AtlasGw methods
  // directly instead of constructing the class per-call via `atlasGwClass()`.
  //
  // NOTE: AtlasGw has no fuzzy-search method — `friends.search()` continues
  // to use the closure-private `HY/jY` codecs + `default-authed-fetch`
  // because the bundle's own search path (`Yz`, byte ~1435000) is REST POST
  // to `/search/search`, not gRPC.
  if (mainSrc.includes("const A=new a.p$({unary:(0,I.Z)()})")) {
    mainSrc = mainSrc.replace(
      "const A=new a.p$({unary:(0,I.Z)()})",
      "const A=globalThis.__SNAPCAP_ATLAS=new a.p$({unary:(0,I.Z)()})",
    );
  } else {
    throw new Error("chat-bundle: A (AtlasGw client) source-patch site missing — bundle version may have shifted");
  }

  // Expose closure-private `N` — the FriendRequests client instance constructed
  // immediately after `A` (the AtlasGw client) in the same module, around chat
  // main byte ~6940668. `N` exposes `Process` (accept/reject/cancel via a oneof
  // action) and `IncomingFriendSync({syncToken?})` — the latter is what
  // populates `state.user.incomingFriendRequests`. The bundle's helper `R(e)`
  // (a few hundred bytes below) calls `N.IncomingFriendSync({syncToken: e})`
  // ONCE at init; the SPA's React layer normally drives subsequent cadence,
  // so consumers without React (us) need an explicit `friends.refresh()`
  // to keep `request:received` events firing.
  //
  // Same `const X=globalThis.__SNAPCAP_X=…` pattern as `Fi`/`Ni`/`jz`/`A` above
  // — preserves the original closure binding inside the module body while
  // giving us a callable reference from outside.
  if (mainSrc.includes("N=new class{rpc;constructor(e){this.rpc=e,this.Process=this.Process.bind(this)")) {
    mainSrc = mainSrc.replace(
      "N=new class{rpc;constructor(e){this.rpc=e,this.Process=this.Process.bind(this)",
      "N=globalThis.__SNAPCAP_FRIEND_REQUESTS=new class{rpc;constructor(e){this.rpc=e,this.Process=this.Process.bind(this)",
    );
  } else {
    throw new Error("chat-bundle: N (FriendRequests client) source-patch site missing — bundle version may have shifted");
  }

  // Make sure happy-dom has a #root so React mount during top-level eval
  // doesn't blow up.
  const doc = sandbox.window.document as { body?: { innerHTML: string }; hasFocus?: () => boolean };
  if (doc?.body && !doc.body.innerHTML.includes('id="root"')) {
    doc.body.innerHTML = (doc.body.innerHTML ?? "") + '<div id="root"></div>';
  }

  // Force `document.hasFocus()` to return true BEFORE the chat bundle
  // evals. The presence slice (chat main byte ~8310100, factory `Zn`)
  // initializes its `awayState` slot from `document.hasFocus()
  // ? Zt.O.Present : Zt.O.Away` at slice creation time. happy-dom's
  // default `hasFocus` returns false in headless contexts; without this
  // patch the slice lands in `Away`, and `broadcastTypingActivity` is
  // gated on `awayState === Present` (so typing pulses get suppressed
  // before they reach `presenceSession.onUserAction`).
  //
  // Patching the underlying happy-dom document object is enough — the
  // bundle's `document` global resolves to the same instance.
  if (doc) {
    (doc as { hasFocus: () => boolean }).hasFocus = (): boolean => true;
  }

  // Wrap the bundle in an IIFE so module/exports/require are scoped
  // locals (matching what `new Function(...)(...)` did before we moved
  // to vm.runInContext). Top-level globalThis still resolves to the
  // sandbox Window, so the bundle's `self.webpackChunk_*` lands there.
  //
  // The `\n` before the close matters: Snap's bundles end in a
  // `//# sourceMappingURL=…` line comment with no trailing newline, so
  // a bare `})(…)` continuation gets eaten by the comment.
  const wrapped =
    `(function(module, exports, require) {\n` +
    mainSrc +
    `\n})({ exports: {} }, {}, function() { throw new Error("require not available (chat main)"); });`;

  try {
    sandbox.runInContext(wrapped, "chat-bundle-main.js");
  } catch {
    // Expected — main has top-level browser-only init paths. Module
    // factories are registered before any throw, which is all we need.
  }

  // Chat bundle pushes into `webpackChunk_snapchat_web_calling_app` (on
  // the sandbox Window). Merge its factories into the chat-only
  // __snapcap_chat_p module map.
  //
  // SEPARATE-RUNTIME RULE: the chat runtime always installs itself as a
  // distinct webpack `require` at `globalThis.__snapcap_chat_p`. The
  // accounts bundle keeps `__snapcap_p`. Module IDs collide between the
  // two bundles (e.g. id 33488 means Next.js `interpolateAs` in accounts
  // and a friending slice in chat), so they must NEVER share a wreq —
  // doing so caches the first-seen factory and downstream modules pull
  // back the wrong shape. The two chunk-array globals already differ
  // (`webpackChunk_N_E` vs `webpackChunk_snapchat_web_calling_app`), so
  // the JS realm is comfortable hosting both runtimes side-by-side.
  const wreq = sandbox.getGlobal<{ m: Record<string, Function> }>("__snapcap_chat_p");
  const arr = sandbox.getGlobal<unknown[]>("webpackChunk_snapchat_web_calling_app");
  if (wreq && Array.isArray(arr)) {
    for (const chunk of arr) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const mods = chunk[1] as Record<string, Function>;
      if (mods && typeof mods === "object") {
        for (const id in mods) {
          const f = mods[id];
          if (f) wreq.m[id] = f;
        }
      }
    }
  }

  sandbox.chatBundleLoaded = true;

  // Priming: force-eval module 10409 (HY/JY/JZ codecs + friend-action
  // client) through a shimmed wreq, then force-eval module 94704 so the
  // Zustand chat-store's `M.getState` is callable. Both are required for
  // any subsequent register.ts getter to succeed; coupled here so api
  // callers don't have to know about them.
  try {
    await primeModule10409(sandbox);
  } catch {
    // Best-effort — friending/search degrade gracefully if HY/JY/JZ
    // didn't land, but auth doesn't depend on these.
  }
  await primeAuthStoreModule(sandbox);
}

/**
 * Convenience accessor for the chat-bundle webpack require. Returns
 * `globalThis.__snapcap_chat_p` from the given sandbox; throws if the
 * chat runtime hasn't been installed yet.
 *
 * Use this anywhere a chat-bundle module needs to be addressed by ID
 * (e.g. modules 74052 / 76877 / 94704 / 79752 / etc.) — never reach for
 * `__snapcap_p` for chat modules, that slot belongs to the accounts
 * runtime and the IDs do not match.
 *
 * @internal Bundle-layer accessor; api files reach the chat wreq via
 * {@link chatWreq} in `./register.ts` (the architecture rule's gate point).
 * @param sandbox - the per-instance {@link Sandbox} owning the bundle eval
 * @returns the chat-bundle webpack require with its `m` factory map
 * @throws when {@link ensureChatBundle} hasn't run yet
 */
export function getChatWreq(sandbox: Sandbox): { (id: string): unknown; m: Record<string, Function> } {
  const wreq = sandbox.getGlobal<{ (id: string): unknown; m: Record<string, Function> }>("__snapcap_chat_p");
  if (!wreq) {
    throw new Error("chat-bundle webpack runtime missing — ensureChatBundle() must run first");
  }
  return wreq;
}

function ensureChatRuntime(sandbox: Sandbox, chatDw: string): void {
  if (sandbox.chatRuntimeLoaded) return;
  // ALWAYS install the chat runtime as `__snapcap_chat_p`, regardless of
  // whether the accounts runtime (`__snapcap_p`) is already present. The
  // two bundles' module IDs collide (id 33488 in accounts is Next.js
  // `interpolateAs`; in chat it's a friending slice with `Y`/`P` exports),
  // so sharing a single webpack require silently corrupts every chat
  // module that pulls in 33488 (notably 94704 — the Zustand auth store —
  // whose constructor `Xp` then throws and TDZ-poisons every consumer).
  //
  // Source-patches: keep the original closure-private `o`
  // (__webpack_require__) binding intact, but also expose it under
  // `globalThis.__snapcap_chat_p` so host code can address chat modules
  // by ID. Anchor `o.m=n,o.amdO={}` is bundle-version-stable.
  if (!sandbox.getGlobal("__snapcap_chat_p")) {
    let runtimeSrc = readFileSync(join(chatDw, "9989a7c6c88a16ebf19d.js"), "utf8");
    if (runtimeSrc.includes("o.m=n,o.amdO={}")) {
      runtimeSrc = runtimeSrc.replace(
        "o.m=n,o.amdO={}",
        "globalThis.__snapcap_chat_p=o,o.m=n,o.amdO={}",
      );
    } else {
      throw new Error("chat-bundle: runtime source-patch site missing — bundle version may have shifted");
    }
    const wrapped =
      `(function(module, exports, require) {\n` +
      runtimeSrc +
      `\n})({ exports: {} }, {}, function() { throw new Error("require not available (chat runtime)"); });`;
    try {
      sandbox.runInContext(wrapped, "chat-bundle-runtime.js");
    } catch {
      // Expected — chat runtime does top-level browser init.
    }
  }
  sandbox.chatRuntimeLoaded = true;
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
}
