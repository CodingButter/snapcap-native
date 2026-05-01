/**
 * Headed Playwright login probe — auto-fills creds, waits for the user
 * to solve any captcha, then captures the resulting session cookies.
 *
 * Use case: confirm an account isn't actually blocked, just captcha-gated;
 * persist its cookies for downstream SDK warm-boot experiments.
 *
 * Usage:  bun run scripts/playwright-login.ts <username>
 *         (creds pulled from .snapcap-smoke.json by username)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const TARGET = process.argv[2] ?? "jamielillee";

const SDK_STATE_PATH = join(import.meta.dir, "..", ".snapcap-smoke.json");
const state = JSON.parse(readFileSync(SDK_STATE_PATH, "utf8")) as {
  accounts: Array<{ username: string; password: string; authPath: string }>;
  fingerprint?: { userAgent: string; viewport?: { width: number; height: number } };
};
const acct = state.accounts.find((a) => a.username === TARGET);
if (!acct) throw new Error(`${TARGET} not in .snapcap-smoke.json`);

const SCREENSHOT_DIR = `/tmp/snapcap-headed-${TARGET}`;
await mkdir(SCREENSHOT_DIR, { recursive: true });
const COOKIES_OUT = join(import.meta.dir, "..", ".tmp", "auth", `${TARGET}.playwright-cookies.json`);

console.log(`[headed] target=${TARGET}`);
console.log(`[headed] screenshots → ${SCREENSHOT_DIR}`);
console.log(`[headed] cookies will be saved → ${COOKIES_OUT}`);

const browser = await chromium.launch({
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
const ctx = await browser.newContext({
  userAgent: state.fingerprint?.userAgent,
  viewport: state.fingerprint?.viewport ?? { width: 1280, height: 800 },
  locale: "en-US",
});
const page = await ctx.newPage();

try {
  console.log(`[headed] navigating to login`);
  await page.goto("https://accounts.snapchat.com/v2/login", { waitUntil: "domcontentloaded", timeout: 45_000 });

  console.log(`[headed] filling username`);
  const userField = await page.waitForSelector(
    'input[name="username"], input[id="username"], input[type="email"], input[autocomplete="username"]',
    { timeout: 30_000 }
  );
  await userField.fill(acct.username);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-username.png` });

  const nextBtn = await page.$(
    'button[type="submit"], button:has-text("Next"), button:has-text("NEXT"), button:has-text("Continue")'
  );
  if (nextBtn) await nextBtn.click();
  else await userField.press("Enter");

  console.log(`[headed] waiting for password field, captcha, or error`);
  const afterUsername = await Promise.race([
    page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 20_000 })
      .then(() => "password" as const),
    page.waitForSelector('iframe[src*="recaptcha"], iframe[src*="captcha"], div.g-recaptcha, [data-sitekey]', { timeout: 20_000 })
      .then(() => "captcha" as const),
    page.waitForSelector('text=/incorrect|invalid|locked|too many|temporarily|disabled/i', { timeout: 20_000 })
      .then(() => "error" as const),
  ]).catch(() => "timeout" as const);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-after-username.png` });
  console.log(`[headed] state after username: ${afterUsername}`);

  if (afterUsername === "captcha") {
    console.log(`[headed] >>>> CAPTCHA — please solve it in the browser window <<<<`);
    console.log(`[headed] waiting up to 5 minutes for password field to appear post-captcha…`);
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 5 * 60_000 });
    console.log(`[headed] password field appeared, captcha cleared`);
  } else if (afterUsername === "error" || afterUsername === "timeout") {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log(`[headed] FAIL after username (${afterUsername}). body snippet:`);
    console.log(body.replace(/\n+/g, " | ").slice(0, 800));
    await browser.close();
    process.exit(2);
  }

  console.log(`[headed] filling password`);
  const pwField = await page.$('input[type="password"], input[name="password"]');
  if (!pwField) throw new Error("password field disappeared");
  await pwField.fill(acct.password);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-password.png` });

  const loginBtn = await page.$(
    'button[type="submit"], button:has-text("Log In"), button:has-text("LOG IN"), button:has-text("Login")'
  );
  if (loginBtn) await loginBtn.click();
  else await pwField.press("Enter");

  console.log(`[headed] waiting for post-login outcome (success / captcha / error)`);
  let post = await Promise.race([
    page.waitForURL(/\/v2\/welcome|snapchat\.com\/web|accounts\.snapchat\.com\/.*\/account/, { timeout: 30_000 })
      .then(() => "success" as const),
    page.waitForSelector('iframe[src*="recaptcha"], iframe[src*="captcha"], div.g-recaptcha, [data-sitekey]', { timeout: 30_000 })
      .then(() => "captcha-after-pw" as const),
    page.waitForSelector('text=/incorrect|invalid|locked|too many|temporarily|disabled/i', { timeout: 30_000 })
      .then(() => "error" as const),
  ]).catch(() => "timeout" as const);

  if (post === "captcha-after-pw") {
    console.log(`[headed] >>>> CAPTCHA after password — please solve it <<<<`);
    console.log(`[headed] waiting up to 5 minutes for redirect…`);
    await page.waitForURL(/\/v2\/welcome|snapchat\.com\/web|accounts\.snapchat\.com\/.*\/account/, { timeout: 5 * 60_000 });
    post = "success";
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-final.png` });
  console.log(`[headed] post-login state: ${post} | url: ${page.url()}`);

  if (post !== "success") {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log(`[headed] FAIL post-password (${post}). body snippet:`);
    console.log(body.replace(/\n+/g, " | ").slice(0, 800));
    await browser.close();
    process.exit(3);
  }

  console.log(`[headed] capturing cookies for *.snapchat.com domains`);
  const cookies = await ctx.cookies();
  const snapCookies = cookies.filter((c) => c.domain.endsWith("snapchat.com"));
  writeFileSync(COOKIES_OUT, JSON.stringify({
    capturedAt: new Date().toISOString(),
    username: acct.username,
    finalUrl: page.url(),
    cookies: snapCookies,
  }, null, 2));
  console.log(`[headed] saved ${snapCookies.length} cookies to ${COOKIES_OUT}`);
  console.log(`[headed] cookie names:`, snapCookies.map((c) => `${c.name}@${c.domain}`).slice(0, 30).join(", "));

  console.log(`\n[headed] RESULT: ${TARGET} is NOT blocked — captcha was solvable, login succeeded`);
  console.log(`[headed] browser will stay open another 5s for inspection`);
  await page.waitForTimeout(5000);
} catch (err) {
  console.log(`[headed] error: ${(err as Error).message}`);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/error.png` }).catch(() => {});
  process.exit(4);
} finally {
  await browser.close();
}
