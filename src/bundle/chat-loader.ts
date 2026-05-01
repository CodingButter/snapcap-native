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
import { getSandbox } from "../shims/runtime.ts";

let chatBundleLoaded = false;
let chatRuntimeLoaded = false;

export type ChatBundleOpts = {
  /** Defaults to vendor/snap-bundle relative to this file. */
  bundleDir?: string;
};

export function ensureChatBundle(opts: ChatBundleOpts = {}): void {
  if (chatBundleLoaded) return;

  const sandbox = getSandbox();
  const bundleDir = opts.bundleDir ?? defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");

  ensureChatRuntime(chatDw);

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

  // Make sure happy-dom has a #root so React mount during top-level eval
  // doesn't blow up.
  const doc = sandbox.window.document as { body?: { innerHTML: string } };
  if (doc?.body && !doc.body.innerHTML.includes('id="root"')) {
    doc.body.innerHTML = (doc.body.innerHTML ?? "") + '<div id="root"></div>';
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

  chatBundleLoaded = true;
}

/**
 * Convenience accessor for the chat-bundle webpack require. Returns
 * `globalThis.__snapcap_chat_p` from the sandbox; throws if the chat
 * runtime hasn't been installed yet.
 *
 * Use this anywhere a chat-bundle module needs to be addressed by ID
 * (e.g. modules 74052 / 76877 / 94704 / 79752 / etc.) — never reach for
 * `__snapcap_p` for chat modules, that slot belongs to the accounts
 * runtime and the IDs do not match.
 */
export function getChatWreq(): { (id: string): unknown; m: Record<string, Function> } {
  const sandbox = getSandbox();
  const wreq = sandbox.getGlobal<{ (id: string): unknown; m: Record<string, Function> }>("__snapcap_chat_p");
  if (!wreq) {
    throw new Error("chat-bundle webpack runtime missing — ensureChatBundle() must run first");
  }
  return wreq;
}

function ensureChatRuntime(chatDw: string): void {
  if (chatRuntimeLoaded) return;
  const sandbox = getSandbox();
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
  chatRuntimeLoaded = true;
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
}
