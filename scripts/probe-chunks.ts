/**
 * Probe Snap's web chat client for every JS/WASM chunk it loads at runtime,
 * then download each one into our local vendor dir. The login bundle alone
 * doesn't contain the messaging modules — they're lazy webpack chunks
 * loaded on demand from cf-st.sc-cdn.net. Capturing them lets us run the
 * full client offline in Node.
 *
 * Usage:
 *   bun run packages/native/scripts/probe-chunks.ts
 *
 * Reuses the Snap profile at ~/.snapcap/profiles/perdyjamie/ — run the SDK's
 * smoke-login once first if you don't have it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { chromium } from "playwright";

const SNAP_USERNAME = process.env.SNAP_USERNAME ?? "perdyjamie";
const SNAP_PASSWORD = process.env.SNAP_PASSWORD ?? "";
const safe = SNAP_USERNAME.replace(/[^A-Za-z0-9_.-]/g, "_");
const useFreshProfile =
  (process.env.FRESH_PROFILE ?? "false") === "true" ||
  (process.env.LOGOUT_FIRST ?? "false") === "true";
const profileDir = useFreshProfile
  ? join("/tmp", `snapcap-probe-profile-${Date.now()}`)
  : join(homedir(), ".snapcap", "profiles", safe);
const outDir =
  process.env.OUT_DIR ?? join(import.meta.dir, "..", "vendor", "snap-bundle");
const settleMs = Number(process.env.SETTLE_MS ?? 30_000);
const interactBrowserMs = Number(process.env.INTERACT_MS ?? 0);

if (useFreshProfile) {
  console.log(
    `[probe] using FRESH profile at ${profileDir} (will run login flow)`,
  );
  mkdirSync(profileDir, { recursive: true });
  if (!SNAP_PASSWORD) {
    console.error("FRESH_PROFILE/LOGOUT_FIRST set but SNAP_PASSWORD is empty");
    process.exit(1);
  }
} else if (!existsSync(profileDir)) {
  console.error(`profile not found: ${profileDir} — run sdk smoke-login first`);
  process.exit(1);
}

console.log(`[probe] profile = ${profileDir}`);
console.log(`[probe] out     = ${outDir}`);
console.log(`[probe] settle  = ${settleMs}ms`);

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
});

const seen = new Set<string>();
const urls: string[] = [];
const ALLOW = /^https:\/\/(static\.snapchat\.com|cf-st\.sc-cdn\.net|accounts\.snapchat\.com|www\.snapchat\.com|web\.snapchat\.com)\//;

ctx.on("request", (req) => {
  const url = req.url();
  if (!ALLOW.test(url)) return;
  if (!/\.(js|wasm|css|json|map)(\?.*)?$/i.test(url)) return;
  if (seen.has(url)) return;
  seen.add(url);
  urls.push(url);
});

const page = await ctx.newPage();

if (useFreshProfile) {
  // Drive the login flow ourselves so we capture every chunk loaded during
  // login. We do it minimally — just enough for Snap to consider us authed.
  console.log("[probe] navigating to login page…");
  await page.goto("https://accounts.snapchat.com/v2/login", {
    waitUntil: "load",
    timeout: 30_000,
  });
  await page.waitForTimeout(3_000);
  const u = page.locator("input#username");
  await u.waitFor({ state: "visible", timeout: 15_000 });
  await u.click();
  await u.type(SNAP_USERNAME, { delay: 80 });
  await u.press("Enter");
  const pw = page.locator('input[type="password"]');
  await pw.waitFor({ state: "visible", timeout: 15_000 });
  await pw.click();
  await pw.type(SNAP_PASSWORD, { delay: 80 });
  await pw.press("Enter");
  console.log("[probe] login submitted; waiting for redirect…");
  await page
    .waitForURL(
      (u) =>
        u.host === "web.snapchat.com" ||
        (u.host === "www.snapchat.com" && u.pathname.startsWith("/web")) ||
        (u.host === "accounts.snapchat.com" && u.pathname.startsWith("/v2/welcome")),
      { timeout: 30_000 },
    )
    .catch(() => {});
  console.log(`[probe]   urls after login=${urls.length}`);
}

console.log("[probe] navigating to chat client…");
try {
  await page.goto("https://www.snapchat.com/web", {
    waitUntil: "load",
    timeout: 30_000,
  });
} catch (e) {
  if (!String(e).includes("ERR_ABORTED")) throw e;
  console.log("[probe]   (ignored ERR_ABORTED — page already navigating)");
  await page.waitForTimeout(3_000);
}

console.log(`[probe] initial settle ${settleMs / 1000}s…`);
let lastReport = 0;
const t0 = Date.now();
while (Date.now() - t0 < settleMs) {
  await page.waitForTimeout(2_000);
  if (urls.length !== lastReport) {
    console.log(`[probe]   t=${Math.round((Date.now() - t0) / 1000)}s urls=${urls.length}`);
    lastReport = urls.length;
  }
}

// Trigger more lazy loads by simulating user actions: dismiss popovers,
// open the Jamie Nichols conversation, type into the chat input, click
// the camera, etc.
console.log("[probe] simulating user actions to trigger lazy chunks…");
async function maybeClick(name: string): Promise<void> {
  const btn = page.getByRole("button", { name, exact: true });
  if (await btn.first().isVisible().catch(() => false)) {
    await btn.first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
}
await maybeClick("Not now");
await maybeClick("Maybe later");

const recipient = process.env.OPEN_CONVERSATION ?? "Jamie Nichols";
const r = page.getByText(recipient, { exact: false }).first();
if (await r.isVisible().catch(() => false)) {
  await r.click();
  console.log(`[probe]   opened conversation "${recipient}"`);
  await page.waitForTimeout(5_000);
  console.log(`[probe]   urls after open conversation=${urls.length}`);

  // Type into chat input to wake up message-send modules.
  const input = page.locator('[contenteditable="true"]').first();
  if (await input.isVisible().catch(() => false)) {
    await input.click();
    await input.type("v3-probe-load", { delay: 60 });
    await page.waitForTimeout(2_000);
    console.log(`[probe]   urls after type=${urls.length}`);

    // Actually send so the CreateContentMessage code path kicks in.
    if ((process.env.SEND_PROBE ?? "true") === "true") {
      // Click last visible button in the chat-input row (Snap's blue send arrow).
      const sendHandle = await page.evaluateHandle(() => {
        const inp = document.querySelector('[contenteditable="true"]');
        if (!inp) return null;
        let cur: Element | null = inp;
        for (let i = 0; i < 6 && cur; i++) {
          const btns = Array.from(cur.querySelectorAll("button")).filter(
            (b) => (b as HTMLElement).offsetParent !== null,
          );
          if (btns.length > 0) return btns[btns.length - 1] as Element;
          cur = cur.parentElement;
        }
        return null;
      });
      const sendEl = sendHandle.asElement();
      if (sendEl) {
        await sendEl.click().catch(async () => {
          await sendEl.evaluate((el) => (el as HTMLElement).click());
        });
        console.log("[probe]   send clicked — waiting for messaging chunks…");
        await page.waitForTimeout(6_000);
        console.log(`[probe]   urls after send=${urls.length}`);
      }
    }

    // Also try uploading a photo to trigger media-send chunks.
    if ((process.env.MEDIA_PROBE ?? "false") === "true") {
      const fi = page.locator('input[type="file"][name="uploadImages"]').first();
      if ((await fi.count()) > 0) {
        await fi.setInputFiles("/tmp/snapcap-test.png").catch(() => {});
        await page.waitForTimeout(3_000);
        console.log(`[probe]   urls after photo upload=${urls.length}`);
      }
    }
  }
}

// Click camera button if visible — loads camera/lens chunks.
const cam = page.getByTitle("New Chat").first();
if (await cam.isVisible().catch(() => false)) {
  await cam.click().catch(() => {});
  await page.waitForTimeout(3_000);
  console.log(`[probe]   urls after camera/new chat=${urls.length}`);
}

if (interactBrowserMs > 0) {
  console.log(
    `[probe] holding browser open for ${interactBrowserMs / 1000}s — interact freely…`,
  );
  await page.waitForTimeout(interactBrowserMs);
}

await ctx.close();

if (useFreshProfile) {
  // Clean up the throwaway profile.
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* tolerate */ }
}

console.log(`\n[probe] captured ${urls.length} chunk URLs THIS RUN`);

// Merge with any existing chunk-urls.txt, deduped.
mkdirSync(outDir, { recursive: true });
const masterPath = join(outDir, "chunk-urls.txt");
const existing = existsSync(masterPath)
  ? require("node:fs")
      .readFileSync(masterPath, "utf8")
      .split(/\r?\n/)
      .filter((l: string) => l.trim())
  : [];
const merged = Array.from(new Set([...existing, ...urls]));
writeFileSync(masterPath, merged.join("\n") + "\n");
console.log(`[probe] master url list now has ${merged.length} unique URLs`);

// Download via fetch (Bun fetch may have IPv6 issues — write a sh script
// using curl as a fallback).
const shPath = join(outDir, "download-chunks.sh");
const lines = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  `OUT_DIR="${outDir}"`,
];
for (const u of merged) {
  const url = new URL(u);
  let p = `${url.host}${url.pathname}`;
  if (p.endsWith("/")) p += "index.html";
  const local = join(outDir, p);
  // Skip if local path collides with an existing directory or vice versa.
  lines.push(
    `mkdir -p "${dirname(local)}" 2>/dev/null && { [ -f "${local}" ] || curl -sSL --max-time 30 --ipv4 -o "${local}" "${u}" 2>/dev/null; }`,
  );
}
writeFileSync(shPath, lines.join("\n") + "\n", { mode: 0o755 });

console.log(`[probe] download script  → ${shPath}`);
console.log(`[probe] url list         → ${join(outDir, "chunk-urls.txt")}`);
console.log(`[probe] run the .sh to fetch everything: bash ${shPath}`);
