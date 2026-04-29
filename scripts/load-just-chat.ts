/**
 * Load JUST the chat client bundle (9846a7958a5f0bee7197.js) to see what
 * its single push gives us. Helps isolate the chat-side capture from
 * cross-bundle interference.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "../src/shims/runtime.ts";
import { installWebpackCapture } from "../src/shims/webpack-capture.ts";

installShims({ url: "https://www.snapchat.com/web" });
const { modules, originals, hints } = installWebpackCapture();

const bundleDir = join(import.meta.dir, "..", "vendor", "snap-bundle");
const path = join(
  bundleDir,
  "cf-st.sc-cdn.net",
  "dw",
  "9846a7958a5f0bee7197.js",
);

console.log("[just-chat] loading just 9846…");
const src = readFileSync(path, "utf8");
try {
  new Function("module", "exports", "require", src)(
    { exports: {} },
    {},
    () => {
      throw new Error("require not available");
    },
  );
  console.log("[just-chat] loaded OK");
} catch (e) {
  console.log("[just-chat] error:", (e as Error).message?.slice(0, 200));
}

const w = globalThis as unknown as Record<string, unknown>;
for (const k of Object.keys(w)) {
  if (!k.startsWith("webpackChunk")) continue;
  const arr = w[k];
  if (!Array.isArray(arr)) continue;
  console.log(`array=${k} chunks=${arr.length}`);
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (!Array.isArray(c)) continue;
    const ids = Array.isArray(c[0]) ? c[0] : [];
    const modCount =
      c[1] && typeof c[1] === "object" ? Object.keys(c[1] as object).length : 0;
    console.log(`  chunk[${i}] ids=[${ids}] modCount=${modCount}`);
  }
}

console.log(`originals captured: ${originals.size}`);
console.log(`modules captured: ${modules.size}`);
console.log(`hints: ${hints.length}`);

// Source scan on originals — also report exact module IDs.
const PATTERNS = [
  "SyncFriendData",
  "MessagingCoreService",
  "FideliusIdentityService",
  "GetSnapchatterPublicInfo",
  "AtlasGw",
  "CreateContentMessage",
];
for (const pat of PATTERNS) {
  const re = new RegExp(pat);
  const matchedIds: string[] = [];
  for (const [stamp, fac] of originals) {
    try {
      if (re.test(fac.toString())) matchedIds.push(stamp);
    } catch {
      /* tolerate */
    }
  }
  console.log(`  "${pat}": ${matchedIds.length} factories — ${matchedIds.slice(0, 5).join(", ")}`);
}

process.exit(0);
