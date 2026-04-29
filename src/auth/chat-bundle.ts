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
 */
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let chatBundleLoaded = false;
let chatRuntimeLoaded = false;

export type ChatBundleOpts = {
  /** Defaults to vendor/snap-bundle relative to this file. */
  bundleDir?: string;
};

/**
 * Load the chat-bundle webpack runtime and main file. The runtime needs
 * a closure-leak patch (mirroring what we do for kameleon's accounts
 * runtime) so its `__webpack_require__` exposes itself as
 * globalThis.__snapcap_p. The main file source-patches two stubs.
 *
 * Caller must ensure happy-dom / kameleon shims are already installed
 * (chat bundle expects browser globals like document, window, etc.).
 */
export function ensureChatBundle(opts: ChatBundleOpts = {}): void {
  if (chatBundleLoaded) return;

  const bundleDir = opts.bundleDir ?? defaultBundleDir();
  const chatDw = join(bundleDir, "cf-st.sc-cdn.net", "dw");

  ensureChatRuntime(chatDw);

  // Pre-stage real Buffer + fs into globalThis so the patched stub
  // modules can hand them out when invoked from main's top-level.
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.__snapcap_node_buffer) g.__snapcap_node_buffer = { Buffer };
  if (!g.__snapcap_node_fs) g.__snapcap_node_fs = fs;

  let mainSrc = readFileSync(join(chatDw, "9846a7958a5f0bee7197.js"), "utf8");
  mainSrc = mainSrc.replace("91903(){}", "91903(e,t){t.Buffer=globalThis.__snapcap_node_buffer.Buffer}");
  mainSrc = mainSrc.replace("36675(){}", "36675(e,t){Object.assign(t,globalThis.__snapcap_node_fs)}");

  // Make sure happy-dom has a #root so React mount during top-level eval
  // doesn't blow up.
  const doc = (globalThis as unknown as { document?: { body?: { innerHTML: string } } }).document;
  if (doc?.body && !doc.body.innerHTML.includes('id="root"')) {
    doc.body.innerHTML = (doc.body.innerHTML ?? "") + '<div id="root"></div>';
  }

  try {
    new Function("module", "exports", "require", mainSrc)(
      { exports: {} },
      {},
      () => {
        throw new Error("require not available (chat main)");
      },
    );
  } catch {
    // Expected — main has top-level browser-only init paths. Module
    // factories are registered before any throw, which is all we need.
  }

  // Chat bundle pushes into `webpackChunk_snapchat_web_calling_app`, a
  // different chunk array than accounts. Merge its factories into the
  // shared __snapcap_p module map.
  const w = globalThis as unknown as {
    __snapcap_p?: { m: Record<string, Function> };
  };
  const arr = (globalThis as unknown as Record<string, unknown[]>)["webpackChunk_snapchat_web_calling_app"];
  if (w.__snapcap_p && Array.isArray(arr)) {
    for (const chunk of arr) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const mods = chunk[1] as Record<string, Function>;
      if (mods && typeof mods === "object") {
        for (const id in mods) {
          const f = mods[id];
          if (f) w.__snapcap_p.m[id] = f;
        }
      }
    }
  }

  chatBundleLoaded = true;
}

/**
 * Load the chat-bundle's own webpack runtime (9989a…). Patches its
 * closure-private `o` variable to expose globalThis.__snapcap_p.
 *
 * Skipped if a webpack runtime is already exposed (kameleon's
 * accounts runtime takes that slot first in normal operation).
 */
function ensureChatRuntime(chatDw: string): void {
  if (chatRuntimeLoaded) return;
  const w = globalThis as unknown as {
    __snapcap_p?: { m: Record<string, Function> };
  };
  // If the kameleon (accounts) runtime already published __snapcap_p,
  // we'll merge chat modules into that same map below — no need to
  // boot another webpack runtime.
  if (!w.__snapcap_p) {
    let runtimeSrc = readFileSync(join(chatDw, "9989a7c6c88a16ebf19d.js"), "utf8");
    if (runtimeSrc.includes("o.m=n,o.amdO={}")) {
      runtimeSrc = runtimeSrc.replace(
        "o.m=n,o.amdO={}",
        "globalThis.__snapcap_p=o,o.m=n,o.amdO={}",
      );
    }
    try {
      new Function("module", "exports", "require", runtimeSrc)(
        { exports: {} },
        {},
        () => {
          throw new Error("require not available (chat runtime)");
        },
      );
    } catch {
      // Expected — chat runtime does top-level browser init.
    }
  }
  chatRuntimeLoaded = true;
}

function defaultBundleDir(): string {
  return join(import.meta.dirname, "..", "..", "vendor", "snap-bundle");
}
