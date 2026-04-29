/**
 * Recon: capture the wire bytes of MessagingCoreService/CreateContentMessage
 * for a TEXT DM (the existing capture is for a story media post).
 *
 * Approach:
 *   1. Reload the SDK's saved auth blob to get the cookie jar + bearer.
 *   2. Launch headless Chromium with a real Chrome UA (Snap blocks default
 *      HeadlessChrome).
 *   3. Inject the cookies into the browser context via Playwright's
 *      cookie API (works for HttpOnly cookies — what document.cookie can't do).
 *   4. Navigate to web.snapchat.com — should land logged in.
 *   5. Click "Team Snapchat" (auto-friend on every account; safe DM target).
 *   6. Type + send a benign message; capture the outgoing CreateContentMessage POST.
 *   7. Save bytes to SnapAutomate/recon-bin/text-dm-create-content-message.req.bin.
 *
 * Skips login UI (and therefore captcha) by inheriting the session.
 */
import { chromium, type Cookie } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";

const BLOB_PATH = process.env.SNAP_AUTH_BLOB ?? "/tmp/snapcap-smoke-auth.json";
const RECIPIENT = process.env.DM_RECIPIENT ?? "Team Snapchat";
const TEXT = process.env.DM_TEXT ?? "snapcap recon test";
const OUT_FILE = process.env.OUT_FILE ?? join(
  import.meta.dirname,
  "..", "..", "SnapAutomate", "recon-bin", "text-dm-create-content-message.req.bin",
);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

console.log(`[recon] blob   = ${BLOB_PATH}`);
console.log(`[recon] target = ${RECIPIENT}`);
console.log(`[recon] text   = ${JSON.stringify(TEXT)}`);
console.log(`[recon] out    = ${OUT_FILE}`);

const blob = JSON.parse(readFileSync(BLOB_PATH, "utf8"));
const jar = await CookieJar.deserialize(blob.jar);

// Convert tough-cookie → Playwright Cookie format.
const allCookies = [
  ...await jar.getCookies("https://www.snapchat.com/"),
  ...await jar.getCookies("https://web.snapchat.com/"),
  ...await jar.getCookies("https://accounts.snapchat.com/"),
];
const seen = new Set<string>();
const cookies: Cookie[] = [];
for (const c of allCookies) {
  const key = `${c.key}@${c.domain}`;
  if (seen.has(key)) continue;
  seen.add(key);
  cookies.push({
    name: c.key,
    value: c.value,
    domain: c.domain ?? ".snapchat.com",
    path: c.path ?? "/",
    expires: c.expires instanceof Date ? Math.floor(c.expires.getTime() / 1000) : -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: normalizeSameSite(c.sameSite),
  });
}
function normalizeSameSite(s: unknown): "Strict" | "Lax" | "None" {
  const v = String(s ?? "").toLowerCase();
  if (v === "strict") return "Strict";
  if (v === "lax") return "Lax";
  return "None";
}

console.log(`[recon] injecting ${cookies.length} cookies`);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
});
await context.addCookies(cookies);

let captured: Buffer | null = null;
let capturedHeaders: Record<string, string> | null = null;
let capturedUrl: string | null = null;
context.on("request", (req) => {
  if (!/messagingcoreservice\.MessagingCoreService\/CreateContentMessage/.test(req.url())) return;
  if (req.method() !== "POST") return;
  const buf = req.postDataBuffer();
  if (buf && (!captured || buf.byteLength > captured.byteLength)) {
    captured = buf;
    capturedHeaders = req.headers();
    capturedUrl = req.url();
    console.log(`[recon] captured CreateContentMessage POST (${buf.byteLength} bytes)`);
  }
});

const page = await context.newPage();
console.log("[recon] navigating /web…");
await page.goto("https://www.snapchat.com/web", { waitUntil: "load", timeout: 30_000 });
await page.waitForTimeout(6_000);

const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "");
console.log(`[recon] page text head: ${JSON.stringify(body)}`);

// Dismiss any modals.
for (const txt of ["Not now", "Maybe later", "Skip", "Got it", "Continue"]) {
  const btn = page.getByRole("button", { name: txt }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

console.log(`[recon] looking for "${RECIPIENT}" in chat list…`);
const target = page.getByText(RECIPIENT, { exact: false }).first();
if (!(await target.isVisible().catch(() => false))) {
  await page.screenshot({ path: "/tmp/snapcap-recon-no-recipient.png", fullPage: true });
  console.error(`[recon] couldn't find "${RECIPIENT}" — screenshot at /tmp/snapcap-recon-no-recipient.png`);
  await browser.close();
  process.exit(2);
}
await target.click();
await page.waitForTimeout(2000);

console.log("[recon] locating message input…");
const input = page.locator('[contenteditable="true"], textarea, [role="textbox"]').first();
if (!(await input.isVisible().catch(() => false))) {
  console.error("[recon] no input visible");
  await page.screenshot({ path: "/tmp/snapcap-recon-no-input.png", fullPage: true });
  await browser.close();
  process.exit(2);
}
await input.click();
await page.waitForTimeout(500);
await input.type(TEXT, { delay: 50 });
await page.waitForTimeout(500);
await input.press("Enter");
console.log("[recon] sent — waiting for outgoing CreateContentMessage…");
await page.waitForTimeout(6000);

if (!captured) {
  console.error("[recon] no CreateContentMessage POST captured");
  await page.screenshot({ path: "/tmp/snapcap-recon-no-capture.png", fullPage: true });
  await browser.close();
  process.exit(3);
}

writeFileSync(OUT_FILE, captured);
const headersOut = OUT_FILE.replace(/\.req\.bin$/, ".req.headers.json");
writeFileSync(headersOut, JSON.stringify({ url: capturedUrl, headers: capturedHeaders }, null, 2));
console.log(`[recon] ✓ wrote ${(captured as Buffer).byteLength} bytes to ${OUT_FILE}`);
console.log(`[recon] ✓ wrote headers to ${headersOut}`);

await browser.close();
process.exit(0);
