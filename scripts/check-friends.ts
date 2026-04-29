/**
 * Just dump our friends and their fidelius pubkeys to see what shape
 * they're in.
 */
import { readFileSync } from "node:fs";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";

const blob = JSON.parse(readFileSync("/tmp/snapcap-smoke-auth.json", "utf8")) as SnapcapAuthBlob;
const client = await SnapcapClient.fromAuth({ auth: blob });
const friends = await client.listFriends();
for (const f of friends) {
  console.log(`${f.username}\t${f.userId}`);
  if (f.fideliusPublicKey) {
    const b = Buffer.from(f.fideliusPublicKey, "base64");
    console.log(`  fideliusPubKey (b64 → ${b.byteLength}B): ${b.toString("hex")}`);
  } else {
    console.log(`  no fideliusPublicKey`);
  }
}
console.log(`my fidelius pubkey: ${blob.fidelius?.publicKey?.slice(0, 80)}`);
