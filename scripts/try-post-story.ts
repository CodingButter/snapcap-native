/**
 * One-shot story-post test using a real Snap web-camera capture.
 * The camera saved a PNG at 406x720 — exactly what the browser uploads.
 */
import { readFileSync } from "node:fs";
import { SnapcapClient, type SnapcapAuthBlob } from "../src/index.ts";

const BLOB_PATH = "/tmp/snapcap-smoke-auth.json";
const IMG_PATH = process.argv[2] ?? "/home/codingbutter/snapcap/Snapchat for Web 2026-4-29 at 3_59_50 AM.png";

const blob = JSON.parse(readFileSync(BLOB_PATH, "utf8")) as SnapcapAuthBlob;
const client = await SnapcapClient.fromAuth({ auth: blob });
console.log(`[story] auth restored. self=${client.self?.username} (${client.self?.userId})`);

const bytes = readFileSync(IMG_PATH);
console.log(`[story] image: ${bytes.byteLength} bytes (${IMG_PATH.split("/").pop()})`);

const t0 = Date.now();
await client.postStory(new Uint8Array(bytes));
console.log(`[story] postStory completed in ${Date.now() - t0}ms (auto-normalized to canonical RGBA PNG)`);
console.log(`[story] check the mobile app for "${client.self?.username}" story`);
