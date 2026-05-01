// Verify Snapchat account login state via CDP-attached Chrome.
// Usage: bun /tmp/verify-account.ts <username> <password> <port>
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const [, , username, password, portStr] = process.argv;
if (!username || !password || !portStr) {
  console.error("usage: verify-account.ts <username> <password> <port>");
  process.exit(2);
}
const port = Number(portStr);
const screenshotDir = "/tmp/snapcap-verify";
await mkdir(screenshotDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const out = (msg: string) => console.log(`[${username}] ${msg}`);

try {
  out("navigating to login");
  await page.goto("https://accounts.snapchat.com/v2/login", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  // wait for username input
  out("waiting for username field");
  const userField = await page.waitForSelector(
    'input[name="username"], input[id="username"], input[type="email"], input[autocomplete="username"]',
    { timeout: 30000 }
  );
  await userField.fill(username);

  // capture screenshot before clicking next
  await page.screenshot({ path: `${screenshotDir}/${username}-1-username.png` });

  // click next
  const nextBtn = await page.$(
    'button[type="submit"], button:has-text("Next"), button:has-text("NEXT"), button:has-text("Continue")'
  );
  if (nextBtn) {
    await nextBtn.click();
  } else {
    await userField.press("Enter");
  }

  out("waiting for password field or error");
  // Wait either for password field, or for an error message
  const result = await Promise.race([
    page
      .waitForSelector('input[type="password"], input[name="password"]', {
        timeout: 15000,
      })
      .then(() => "password-field"),
    page
      .waitForSelector(
        'text=/incorrect|invalid|locked|too many|try again|temporarily|disabled/i',
        { timeout: 15000 }
      )
      .then(() => "error-after-username"),
    page
      .waitForSelector('iframe[src*="recaptcha"], div.g-recaptcha, [data-sitekey]', {
        timeout: 15000,
      })
      .then(() => "captcha"),
  ]).catch(() => "timeout");

  await page.screenshot({ path: `${screenshotDir}/${username}-2-after-username.png` });
  out(`after-username state: ${result}`);

  if (result === "captcha") {
    out("CAPTCHA detected after username");
    console.log(`RESULT:${username}:captcha-after-username:${page.url()}`);
    await browser.close();
    process.exit(0);
  }

  if (result === "error-after-username" || result === "timeout") {
    // capture body text
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    out(`error/timeout body snippet: ${bodyText.replace(/\n/g, " | ").slice(0, 400)}`);
    console.log(
      `RESULT:${username}:error-or-timeout-after-username:${page.url()}`
    );
    console.log(`BODY:${bodyText.replace(/\n/g, " | ")}`);
    await browser.close();
    process.exit(0);
  }

  // password field appeared
  const pwField = await page.$('input[type="password"], input[name="password"]');
  if (!pwField) {
    out("password field disappeared");
    console.log(`RESULT:${username}:no-password-field:${page.url()}`);
    await browser.close();
    process.exit(0);
  }
  await pwField.fill(password);
  await page.screenshot({ path: `${screenshotDir}/${username}-3-password.png` });

  const loginBtn = await page.$(
    'button[type="submit"], button:has-text("Log In"), button:has-text("LOG IN"), button:has-text("Login")'
  );
  if (loginBtn) {
    await loginBtn.click();
  } else {
    await pwField.press("Enter");
  }

  out("waiting for post-login outcome");
  // Wait for navigation/redirect, captcha, or error
  const post = await Promise.race([
    page
      .waitForURL(/\/v2\/welcome|snapchat\.com\/web|accounts\.snapchat\.com\/.*\/account/, {
        timeout: 25000,
      })
      .then(() => "success-redirect"),
    page
      .waitForSelector(
        'text=/incorrect|invalid password|wrong password|locked|too many|temporarily|disabled|try again/i',
        { timeout: 25000 }
      )
      .then(() => "error-after-password"),
    page
      .waitForSelector('iframe[src*="recaptcha"], div.g-recaptcha, [data-sitekey]', {
        timeout: 25000,
      })
      .then(() => "captcha"),
  ]).catch(() => "post-timeout");

  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${screenshotDir}/${username}-4-final.png` });
  const finalUrl = page.url();
  const finalBody = await page.evaluate(() =>
    document.body.innerText.slice(0, 1500)
  );
  out(`post-login state: ${post} | url: ${finalUrl}`);
  console.log(`RESULT:${username}:${post}:${finalUrl}`);
  console.log(`BODY:${finalBody.replace(/\n/g, " | ")}`);
} catch (err) {
  out(`error: ${(err as Error).message}`);
  await page.screenshot({ path: `${screenshotDir}/${username}-error.png` }).catch(() => {});
  console.log(`RESULT:${username}:exception:${(err as Error).message}`);
} finally {
  await browser.close();
}
