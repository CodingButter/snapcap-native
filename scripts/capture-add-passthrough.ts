/**
 * Pass-through wire capture for `friends.add`.
 *
 * Difference vs `capture-add-friend-body.ts`: this version forwards the
 * intercepted request to Snap and logs the real response (status, headers,
 * body bytes, decoded grpc-status / grpc-message). The point is to see
 * exactly what Snap's server returns when our SDK calls `AddFriends` —
 * is it 200/grpc-status:0 (silent drop), or is there an error code we've
 * been throwing away because friendActionMutation discards the response?
 *
 * Usage: bun run scripts/capture-add-passthrough.ts <recipient-username> <sender-username>
 *   defaults: recipient=jamie_nichols sender=jamielillee
 */
const ADD_URL_FRAGMENT = "Friends";   // matches AddFriends, RemoveFriends, etc.

const RECIPIENT = process.argv[2] ?? "jamie_nichols";
const SENDER    = process.argv[3] ?? "jamielillee";

const captures: Array<{ url: string; reqBytes: number; reqHex: string; reqUtf8: string; status: number; headers: Record<string,string>; respBytes: number; respHex: string; respUtf8: string }> = [];

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const [input, init] = args;
  const url = typeof input === "string" ? input : (input as Request | URL).toString();
  const isFriendAction = url.includes("FriendAction") || (url.includes(ADD_URL_FRAGMENT) && (init?.method ?? "GET") !== "GET");

  if (!isFriendAction) return originalFetch(...args);

  let reqBytes = new Uint8Array();
  if (init?.body) {
    if (init.body instanceof Uint8Array) reqBytes = init.body;
    else if (init.body instanceof ArrayBuffer) reqBytes = new Uint8Array(init.body);
    else if (typeof init.body === "string") reqBytes = new TextEncoder().encode(init.body);
  }

  const reqUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(reqBytes);
  console.log(`\n[capture] >>> ${init?.method ?? "?"} ${url}`);
  console.log(`[capture]     req bytes: ${reqBytes.length}`);
  console.log(`[capture]     req hex (full): ${Buffer.from(reqBytes).toString("hex")}`);
  console.log(`[capture]     req utf8 (escaped): ${JSON.stringify(reqUtf8.slice(0, 512))}`);

  // Forward to Snap and capture response
  const resp = await originalFetch(...args);
  const headersObj: Record<string,string> = {};
  resp.headers.forEach((v, k) => { headersObj[k] = v; });
  const respBuf = await resp.arrayBuffer();
  const respBytes = new Uint8Array(respBuf);
  const respUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(respBytes);

  console.log(`[capture] <<< status=${resp.status}`);
  console.log(`[capture]     headers:`, headersObj);
  console.log(`[capture]     resp bytes: ${respBytes.length}`);
  console.log(`[capture]     resp hex (full): ${Buffer.from(respBytes).toString("hex")}`);
  console.log(`[capture]     resp utf8 (escaped): ${JSON.stringify(respUtf8.slice(0, 1024))}`);

  captures.push({ url, reqBytes: reqBytes.length, reqHex: Buffer.from(reqBytes).toString("hex"), reqUtf8: reqUtf8.slice(0, 512), status: resp.status, headers: headersObj, respBytes: respBytes.length, respHex: Buffer.from(respBytes).toString("hex"), respUtf8: respUtf8.slice(0, 1024) });

  // Re-wrap the consumed body
  return new Response(respBytes, { status: resp.status, headers: resp.headers });
}) as typeof fetch;

const { SnapcapClient } = await import("../src/client.ts");
const { FileDataStore } = await import("../src/storage/data-store.ts");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");

const SDK_ROOT = join(import.meta.dir, "..");
const state = JSON.parse(readFileSync(join(SDK_ROOT, ".snapcap-smoke.json"), "utf8"));
const acct = state.accounts.find((a: any) => a.username === SENDER);
if (!acct) { console.error(`no sender ${SENDER} in smoke state`); process.exit(2); }

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, acct.authPath)),
  username: acct.username,
  password: acct.password,
  userAgent: state.fingerprint?.userAgent,
});

console.log(`[capture] authenticating as ${SENDER}…`);
await client.authenticate();
if (!client.isAuthenticated()) { console.error(`[capture] auth failed`); process.exit(3); }

console.log(`[capture] searching for recipient ${RECIPIENT}…`);
const results = await client.friends.search(RECIPIENT);
const target = (Array.isArray(results) ? results : []).find((r: any) => r.username === RECIPIENT);
if (!target) { console.error(`[capture] no exact match for ${RECIPIENT}`); process.exit(4); }
console.log(`[capture] target: ${target.username} (${target.userId})`);

console.log(`[capture] calling friends.add(${target.userId})…`);
try {
  await client.friends.add(target.userId);
  console.log(`[capture] friends.add resolved without throwing`);
} catch (e) {
  console.log(`[capture] friends.add threw: ${(e as Error).message}`);
}

console.log(`\n[capture] === SUMMARY ===`);
console.log(`captures: ${captures.length}`);
for (const c of captures) {
  console.log(`  ${c.url}`);
  console.log(`    status=${c.status} grpc-status=${c.headers["grpc-status"]} grpc-message=${c.headers["grpc-message"]}`);
}
process.exit(0);
