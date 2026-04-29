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
  // the sandbox Window). Merge its factories into the shared
  // __snapcap_p module map.
  const wreq = sandbox.getGlobal<{ m: Record<string, Function> }>("__snapcap_p");
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

function ensureChatRuntime(chatDw: string): void {
  if (chatRuntimeLoaded) return;
  const sandbox = getSandbox();
  // If a webpack runtime is already exposed (kameleon's accounts runtime
  // takes that slot first in normal operation), merge into it.
  if (!sandbox.getGlobal("__snapcap_p")) {
    let runtimeSrc = readFileSync(join(chatDw, "9989a7c6c88a16ebf19d.js"), "utf8");
    if (runtimeSrc.includes("o.m=n,o.amdO={}")) {
      runtimeSrc = runtimeSrc.replace(
        "o.m=n,o.amdO={}",
        "globalThis.__snapcap_p=o,o.m=n,o.amdO={}",
      );
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
