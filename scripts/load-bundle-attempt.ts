/**
 * Try to load Snap's downloaded bundle into a shimmed Node runtime and
 * record what blows up. Each script is loaded in order; errors are
 * captured but don't halt the run, so we get a complete picture of which
 * APIs the bundle expects.
 *
 *   bun run packages/native/scripts/load-bundle-attempt.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../src/shims/runtime.ts";
import { installWebpackCapture } from "../src/shims/webpack-capture.ts";

const bundleDir =
  process.env.BUNDLE_DIR ?? join(import.meta.dir, "..", "vendor", "snap-bundle");

console.log("[load] installing shims…");
installShims({ url: "https://accounts.snapchat.com/v2/login" });
console.log("[load] shim installed; window/document/navigator now on globalThis");

const { modules, originals, hints } = installWebpackCapture();
console.log("[load] webpack capture armed");

// Sanity-check the global aliases.
const gAny = globalThis as unknown as Record<string, unknown>;
console.log(
  `[load]   self === globalThis: ${gAny.self === globalThis}, window === globalThis: ${gAny.window === globalThis}`,
);
console.log(
  `[load]   webpackChunk_N_E pre-loaded: ${Array.isArray(gAny.webpackChunk_N_E)}`,
);

// Inject the page's __NEXT_DATA__ blob — Next.js's runtime needs it to
// hydrate. We pull it straight out of the login HTML we downloaded.
function injectNextData(): void {
  const loginHtmlPath = join(
    bundleDir,
    "accounts.snapchat.com",
    "v2",
    "login",
  );
  let html: string;
  try {
    html = readFileSync(loginHtmlPath, "utf8");
  } catch {
    console.log("[load]   (no login HTML — skipping __NEXT_DATA__ inject)");
    return;
  }
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) {
    console.log("[load]   (couldn't find __NEXT_DATA__ in login HTML)");
    return;
  }
  const node = document.createElement("script");
  node.id = "__NEXT_DATA__";
  node.type = "application/json";
  node.textContent = m[1] ?? "";
  document.head.appendChild(node);
  console.log(
    "[load]   injected __NEXT_DATA__ (" + (m[1]?.length ?? 0) + " chars)",
  );
}
injectNextData();

// Quick sanity check.
console.log("[load]   document =", typeof document);
console.log("[load]   navigator.userAgent =", navigator.userAgent.slice(0, 60));
console.log("[load]   fetch =", typeof fetch);
console.log("[load]   WebSocket =", typeof WebSocket);

// Find every .js file under the bundle dir, sorted to roughly match load
// order: polyfills → webpack → framework → main → app → chunks.
function walkJs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkJs(p));
    else if (st.isFile() && p.endsWith(".js")) out.push(p);
  }
  return out;
}

const ORDER_HINT = [
  "polyfills",
  "webpack-",
  "framework-",
  "main-",
  "_app-",
  "_buildManifest",
  "_ssgManifest",
];

function loadOrder(path: string): number {
  const base = path.split("/").pop() ?? path;
  for (let i = 0; i < ORDER_HINT.length; i++) {
    if (base.includes(ORDER_HINT[i]!)) return i;
  }
  return 100; // chunks last
}

const files = walkJs(bundleDir).sort((a, b) => loadOrder(a) - loadOrder(b));
console.log(`[load] ${files.length} .js files found`);

const errors: { file: string; error: string }[] = [];
const loaded: { file: string; bytes: number }[] = [];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    // eval into the shimmed global. We don't sandbox — the shim IS our box.
    // eslint-disable-next-line no-new-func
    new Function("module", "exports", "require", src)(
      { exports: {} },
      {},
      () => {
        throw new Error("require(): unmocked CommonJS require");
      },
    );
    loaded.push({ file: f.replace(bundleDir + "/", ""), bytes: src.length });
    console.log(`  ✓ ${f.replace(bundleDir + "/", "")}`);
  } catch (e) {
    const err = e as Error;
    const msg = err.message?.slice(0, 200) ?? String(err);
    errors.push({ file: f.replace(bundleDir + "/", ""), error: msg });
    console.log(`  ✗ ${f.replace(bundleDir + "/", "")}`);
    console.log(`      → ${msg}`);
  }
}

console.log(`\n[load] loaded=${loaded.length} errored=${errors.length}`);
if (errors.length) {
  console.log("\n=== load errors ===");
  for (const e of errors) {
    console.log(`  ${e.file}\n    ${e.error}`);
  }
}

// Inspect whether webpack's runtime registered itself.
const w = globalThis as unknown as Record<string, unknown>;
const webpackKey = Object.keys(w).find((k) => k.startsWith("webpackChunk"));
console.log(
  `\n[load] webpack chunk array global: ${webpackKey ?? "(not found)"}`,
);
if (webpackKey) {
  const arr = w[webpackKey] as unknown[];
  console.log(`  chunks pushed: ${Array.isArray(arr) ? arr.length : 0}`);
}

console.log(`\n[load] modules captured (pre-force-load): ${modules.size}`);
console.log(`[load] hint matches (pre-force-load): ${hints.length}`);

// Capture any unhandled errors that fire from scheduled work.
const lateErrors: Error[] = [];
process.on("uncaughtException", (e) => lateErrors.push(e));
process.on("unhandledRejection", (e) => lateErrors.push(e as Error));

// We can't rely on webpack auto-invoking modules — Snap's chunks have no
// `chunk[2]` runtime function, so factories sit in `p.m` waiting for someone
// to call `p(id)`. We implement our own require over the captured factories
// in webpackChunk_N_E and force-load every module.
//
// Aggregate factories from all chunks first.
const allFactories: Record<string, Function> = {};
const gAll = globalThis as unknown as Record<string, unknown>;
let totalChunks = 0;
for (const k of Object.keys(gAll)) {
  if (!k.startsWith("webpackChunk")) continue;
  const arr = gAll[k];
  if (!Array.isArray(arr)) continue;
  for (const chunk of arr) {
    if (!Array.isArray(chunk) || chunk.length < 2) continue;
    totalChunks += 1;
    const modulesObj = chunk[1];
    if (modulesObj && typeof modulesObj === "object") {
      for (const id of Object.keys(modulesObj as object)) {
        const fac = (modulesObj as Record<string, unknown>)[id];
        if (typeof fac === "function") allFactories[id] = fac as Function;
      }
    }
  }
}
console.log(
  `\n[load] aggregated ${Object.keys(allFactories).length} factories from ${totalChunks} chunks`,
);
// Per-array chunk + factory counts for debugging.
for (const k of Object.keys(gAll)) {
  if (!k.startsWith("webpackChunk")) continue;
  const arr = gAll[k];
  if (!Array.isArray(arr)) continue;
  let mods = 0;
  for (const c of arr) {
    if (Array.isArray(c) && c.length >= 2 && typeof c[1] === "object" && c[1]) {
      mods += Object.keys(c[1] as object).length;
    }
  }
  console.log(`  array=${k} chunks=${arr.length} modules=${mods}`);
  // Dump per-chunk shape so we can see what's actually in the chat array.
  if (k === "webpackChunk_snapchat_web_calling_app") {
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (Array.isArray(c)) {
        const chunkIds = Array.isArray(c[0]) ? (c[0] as unknown[]) : [];
        const modKeys =
          c[1] && typeof c[1] === "object" ? Object.keys(c[1] as object) : [];
        console.log(
          `    chat-chunk[${i}] ids=[${chunkIds.join(",")}] modCount=${modKeys.length} firstMod=${modKeys[0] ?? "-"}`,
        );
      }
    }
  }
}

// Sanity: do ANY factories contain 'webpack' or known strings?
let probe = 0;
for (const id of Object.keys(allFactories).slice(0, 20)) {
  const src = allFactories[id]!.toString();
  if (/SyncFriendData|messagingcoreservice|CreateContentMessage/.test(src)) probe++;
}
console.log(`[load] probe-among-first-20: ${probe} hits`);

// Build our own webpack-style require with the standard runtime helpers
// Snap's bundles expect.
type ModSlot = { id: string; exports: unknown };
const cache: Record<string, ModSlot> = {};
function snapRequire(id: string): unknown {
  if (cache[id]) return cache[id]!.exports;
  const fac = allFactories[id];
  if (!fac) throw new Error(`unknown module: ${id}`);
  const mod: ModSlot = (cache[id] = { id, exports: {} });
  fac.call(mod.exports, mod, mod.exports, snapRequire);
  return mod.exports;
}
const sr = snapRequire as unknown as Record<string, unknown>;
sr.m = allFactories;
sr.c = cache;
sr.g = globalThis;
sr.o = (obj: object, prop: string) =>
  Object.prototype.hasOwnProperty.call(obj, prop);
sr.d = (target: object, defs: Record<string, () => unknown>) => {
  for (const key of Object.keys(defs)) {
    if (
      Object.prototype.hasOwnProperty.call(defs, key) &&
      !Object.prototype.hasOwnProperty.call(target, key)
    ) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get: defs[key],
      });
    }
  }
};
sr.r = (target: object) => {
  if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
    Object.defineProperty(target, Symbol.toStringTag, { value: "Module" });
  }
  Object.defineProperty(target, "__esModule", { value: true });
};
sr.n = (mod: { __esModule?: boolean; default?: unknown }) => {
  const getter = mod && mod.__esModule ? () => mod.default : () => mod;
  (sr.d as Function)(getter, { a: getter });
  return getter;
};
sr.t = function compatT(value: unknown, mode: number): unknown {
  if ((mode & 1) === 1) value = (snapRequire as Function)(value as string);
  if ((mode & 8) === 8) return value;
  if ((mode & 4) === 4 && typeof value === "object" && value && (value as { __esModule?: boolean }).__esModule) {
    return value;
  }
  const ns: Record<string, unknown> = {};
  (sr.r as Function)(ns);
  Object.defineProperty(ns, "default", { enumerable: true, value });
  if ((mode & 2) === 2 && typeof value !== "string") {
    for (const key in value as object) {
      (sr.d as Function)(ns, {
        [key]: () => (value as Record<string, unknown>)[key],
      });
    }
  }
  return ns;
};
sr.e = () => Promise.resolve();
sr.p = "";
sr.u = (chunkId: string) => `static/chunks/${chunkId}.js`;

// __webpack_require__.a — async-module helper for top-level await.
// Simplified: synchronously call the body; its returned Promise hangs.
sr.a = function asyncModule(
  module: { exports: unknown },
  body: (
    declareDeps: (deps: unknown[]) => unknown[],
    onDone: () => void,
  ) => unknown,
  _hasAwait?: boolean,
): unknown {
  const declareDeps = (deps: unknown[]) => deps;
  const onDone = () => {};
  try {
    const result = body(declareDeps, onDone);
    // If it returned a promise, attach a noop to avoid unhandledRejection.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(
        () => {},
        () => {},
      );
    }
  } catch {
    /* tolerate — module top-level errors don't crash the process */
  }
  return module.exports;
};

// __webpack_require__.nmd, hmd — set module type marker for bundle helpers.
sr.nmd = (module: { exports: unknown; type?: string }) => {
  module.type = "module";
  return module;
};
sr.hmd = sr.nmd;

console.log("[load] force-loading all modules with our require…");
let okCount = 0;
let errCount = 0;
const errSamples: Array<{ id: string; msg: string }> = [];
for (const id of Object.keys(allFactories)) {
  try {
    snapRequire(id);
    okCount += 1;
  } catch (e) {
    errCount += 1;
    if (errSamples.length < 5) {
      errSamples.push({ id, msg: (e as Error).message?.slice(0, 200) ?? String(e) });
    }
  }
}
console.log(`[load] force-load: ${okCount} ok, ${errCount} errors`);
if (errSamples.length) {
  console.log("[load] first errors:");
  for (const e of errSamples) console.log(`  #${e.id}: ${e.msg}`);
}

console.log(`[load] modules captured (post-force-load): ${modules.size}`);
console.log(`[load] hint matches (post-force-load): ${hints.length}`);
for (const h of hints.slice(0, 10)) {
  console.log(`  id=${h.moduleId} hint=${h.hint} keys=[${h.keys.slice(0, 6).join(",")}…]`);
}

// Source-level scan AFTER force-load — search FACTORY bodies (not exports
// — exports lose the factory-internal string literals).
const SOURCE_PATTERNS = [
  "CreateContentMessage",
  "SyncFriendData",
  "GetSnapchatterPublicInfo",
  "MessagingCoreService",
  "FideliusIdentityService",
  "InitializeWebKey",
  "AtlasGw",
];
// Sanity: dump first 3, last 3, and total source size summary.
const allOrig = Array.from(originals);
console.log(`\n[load] sanity (first 3, last 3 originals):`);
for (const [stamp, fac] of allOrig.slice(0, 3).concat(allOrig.slice(-3))) {
  try {
    const src = fac.toString();
    console.log(`  ${stamp}: ${src.length} chars sample="${src.slice(0, 100).replace(/\s+/g, " ")}"`);
  } catch (e) {
    console.log(`  ${stamp}: toString threw ${(e as Error).message}`);
  }
}
let totalSrcChars = 0;
for (const [, fac] of originals) {
  try {
    totalSrcChars += fac.toString().length;
  } catch {
    /* tolerate */
  }
}
console.log(`[load] total factory source bytes: ${totalSrcChars}`);

// Dump all factory sources to disk for grep.
import { writeFileSync as wfs } from "node:fs";
const dump = Array.from(originals)
  .map(([stamp, fac]) => {
    try {
      return `// ${stamp}\n${fac.toString()}\n`;
    } catch {
      return `// ${stamp} <toString failed>\n`;
    }
  })
  .join("\n");
const dumpPath = "/tmp/snapcap-factory-dump.js";
wfs(dumpPath, dump);
console.log(`[load] dumped ${dump.length} chars of factory sources → ${dumpPath}`);
console.log(`\n[load] source-level scan of ${originals.size} ORIGINAL factories:`);
for (const pat of SOURCE_PATTERNS) {
  const re = new RegExp(pat);
  const matched: { id: string; sample: string }[] = [];
  for (const [id, fac] of originals) {
    try {
      const src = fac.toString();
      if (re.test(src)) {
        matched.push({ id, sample: src.slice(0, 200).replace(/\s+/g, " ") });
      }
    } catch {
      /* tolerate */
    }
  }
  console.log(`  "${pat}": ${matched.length} matches`);
  for (const m of matched.slice(0, 3))
    console.log(`     #${m.id}: ${m.sample}…`);
}
if (lateErrors.length) {
  console.log(`\n[load] late errors during settle (${lateErrors.length}):`);
  for (const e of lateErrors.slice(0, 10)) {
    console.log(`  ${e.message?.slice(0, 200)}`);
  }
}
process.exit(0);
