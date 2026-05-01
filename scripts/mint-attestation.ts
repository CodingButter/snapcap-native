/**
 * Mint a kameleon attestation token from the command line.
 *
 *   bun run scripts/mint-attestation.ts perdyjamie
 *
 * Use the resulting token as `webLoginHeaderBrowser.attestationPayload`
 * (UTF-8 encoded) when calling WebLoginService.
 */
import { Sandbox } from "../src/shims/sandbox.ts";
import { bootKameleon } from "../src/bundle/accounts-loader.ts";

const identifier = process.argv[2] ?? process.env.SNAP_USER;
if (!identifier) {
  console.error("usage: bun run scripts/mint-attestation.ts <username|email|phone>");
  process.exit(1);
}

console.log(`[mint] booting kameleon…`);
const sandbox = new Sandbox({ url: "https://accounts.snapchat.com/v2/login" });
const ctx = await bootKameleon(sandbox, { page: process.env.SNAP_PAGE ?? "www_login" });
console.log(`[mint] generating attestation for "${identifier}"…`);
const tok = await ctx.finalize(identifier);
console.log(`[mint] ✓ token len=${tok.length}`);
console.log(tok);
process.exit(0);
