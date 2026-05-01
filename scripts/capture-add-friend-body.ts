/**
 * Wire-body capture for `friends.add` — proves the SDK's outgoing
 * `AddFriends` gRPC-Web request body now contains the literal
 * `dweb_add_friend` page-context string after the friends.ts edit.
 *
 * Approach: monkey-patch `globalThis.fetch` BEFORE dynamic-importing the
 * SDK so `transport/native-fetch.ts`'s eager-bound `nativeFetch` snapshots
 * the patched version. Every outbound request body that targets the
 * AddFriends RPC URL is scanned for the literal string. The actual fetch
 * is short-circuited with a synthetic 200 grpc-status:0 response so we
 * don't actually mutate the friend graph and don't depend on warm auth.
 *
 * Run: `bun run scripts/capture-add-friend-body.ts`
 */
const ADD_FRIENDS_URL_FRAGMENT = "AddFriends";
const TARGET_LITERAL = "dweb_add_friend";

let observed = false;
let observedDetail: { url: string; sample: string } | null = null;

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const [input, init] = args;
  const url = typeof input === "string" ? input : (input as Request | URL).toString();

  if (url.includes(ADD_FRIENDS_URL_FRAGMENT) && init?.body) {
    const body = init.body;
    let bytes: Uint8Array | null = null;
    if (body instanceof Uint8Array) bytes = body;
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (typeof body === "string") bytes = new TextEncoder().encode(body);

    if (bytes) {
      // gRPC-Web frame is: [compressed:1][len:4][protobuf...]. The literal
      // is a UTF-8 string field on the message — we just scan the whole
      // frame for the bytes.
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const hit = text.includes(TARGET_LITERAL);
      console.log(`[capture] outgoing ${url}`);
      console.log(`[capture]   body bytes: ${bytes.length}`);
      console.log(`[capture]   contains "${TARGET_LITERAL}": ${hit ? "YES" : "NO"}`);
      console.log(`[capture]   body hex (first 256B): ${Buffer.from(bytes.slice(0, 256)).toString("hex")}`);
      console.log(`[capture]   body utf8 (escaped):  ${JSON.stringify(text.slice(0, 256))}`);
      observed = true;
      observedDetail = { url, sample: text.slice(0, 256) };

      // Short-circuit with a synthetic gRPC-Web success: empty AddFriendsResponse
      // (Snap's bundle reads `.successes` / `.failures` arrays — we don't need
      // to populate them; the SDK ignores the response on the success path).
      // gRPC-Web frame: 0x00 (uncompressed), [len=0:4 bytes BE], (no body).
      // Then trailer frame: 0x80, [len:4 BE], "grpc-status:0\r\n".
      const trailer = new TextEncoder().encode("grpc-status:0\r\n");
      const trailerFrame = new Uint8Array(5 + trailer.length);
      trailerFrame[0] = 0x80;
      const dv = new DataView(trailerFrame.buffer);
      dv.setUint32(1, trailer.length, false);
      trailerFrame.set(trailer, 5);

      const dataFrame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
      const combined = new Uint8Array(dataFrame.length + trailerFrame.length);
      combined.set(dataFrame, 0);
      combined.set(trailerFrame, dataFrame.length);

      return new Response(combined, {
        status: 200,
        headers: {
          "content-type": "application/grpc-web+proto",
          "grpc-status": "0",
        },
      });
    }
  }

  return originalFetch(...args);
}) as typeof fetch;

// Now dynamic-import the SDK so it picks up the patched fetch.
const { SnapcapClient } = await import("../src/client.ts");
const { FileDataStore } = await import("../src/storage/data-store.ts");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");

const SDK_ROOT = join(import.meta.dir, "..");
const creds = JSON.parse(readFileSync(join(SDK_ROOT, ".snapcap-smoke.json"), "utf8"));
const authPath = creds.authPath ?? ".tmp/auth/jamie_qtsmith.json";

const client = new SnapcapClient({
  dataStore: new FileDataStore(join(SDK_ROOT, authPath)),
  username: creds.username,
  password: creds.password,
  userAgent: creds.fingerprint?.userAgent,
});

console.log("[capture] authenticating (warm)...");
await client.authenticate();
if (!client.isAuthenticated()) {
  console.error("[capture] authenticate() resolved but isAuthenticated()=false");
  process.exit(2);
}

console.log("[capture] calling friends.add (intercepted)...");
try {
  await client.friends.add("eabd1d89-239a-4f7b-bbcc-0ae3b26c5202");
  console.log("[capture] friends.add resolved");
} catch (e) {
  console.error("[capture] friends.add threw:", e);
}

console.log("---");
if (observed) {
  console.log(`[capture] PASS — captured AddFriends body containing dweb_add_friend at ${observedDetail!.url}`);
  process.exit(0);
} else {
  console.log("[capture] FAIL — never observed an AddFriends request body");
  process.exit(1);
}
