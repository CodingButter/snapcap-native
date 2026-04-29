/**
 * Local Fidelius round-trip self-test.
 *
 * Mints two identities via the WASM (Alice + Bob), then performs an
 * ECDH-P256 → HKDF → AES-GCM encrypt/decrypt round-trip between them
 * using node:crypto. Doesn't talk to any server. Validates that:
 *
 *   1. The WASM's generateKeyInitializationRequest produces real
 *      P-256 keypairs that round-trip through node:crypto's ECDH.
 *   2. The 65-byte cleartextPublicKey is in SEC1-uncompressed form
 *      (0x04 prefix) directly importable by createPublicKey({type:"spki"}).
 *   3. We can derive a shared secret + symmetric key + send a payload
 *      that the recipient can decrypt back to plaintext.
 *
 * Note: this is NOT compatible with Snap's exact Fidelius wire format
 * yet — that has specific KDF salt/info/AAD bytes we haven't recovered.
 * This is a self-test of the *primitives* with the WASM keys.
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mintFideliusIdentity, type FideliusIdentity } from "../src/auth/fidelius-mint.ts";

// Use stderr for output so it doesn't get reordered with the WASM's own
// console.log writes (Snap's bundle prints version info on load).
const log = (s: string): void => { process.stderr.write(s + "\n"); };

log("[roundtrip] minting Alice…");
const alice = await mintFideliusIdentity();
log(`  pub=${alice.cleartextPublicKey.byteLength}B priv=${alice.cleartextPrivateKey.byteLength}B`);

log("[roundtrip] minting Bob…");
const bob = await mintFideliusIdentity();
log(`  pub=${bob.cleartextPublicKey.byteLength}B priv=${bob.cleartextPrivateKey.byteLength}B`);

// Convert WASM-output keys → node:crypto KeyObject. Public is SEC1-
// uncompressed (0x04 || X || Y). Private is the raw 32-byte scalar.
function loadPublicKey(pubBytes: Uint8Array) {
  // ASN.1 SubjectPublicKeyInfo wrapper for P-256 with uncompressed point.
  // Header is fixed for all P-256 SPKI uncompressed keys.
  const spkiPrefix = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex",
  );
  const spki = Buffer.concat([spkiPrefix, Buffer.from(pubBytes)]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

function loadPrivateKey(privScalar: Uint8Array, pubBytes: Uint8Array) {
  // PKCS8 wrapper for P-256. Embed the 32-byte scalar + 65-byte public.
  // Build it manually so we don't need any extra deps.
  // Easier path: build a JWK from the components and let node:crypto load it.
  const jwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: base64url(pubBytes.slice(1, 33)),
    y: base64url(pubBytes.slice(33, 65)),
    d: base64url(privScalar),
  };
  return createPrivateKey({ key: jwk, format: "jwk" });
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const alicePriv = loadPrivateKey(alice.cleartextPrivateKey, alice.cleartextPublicKey);
const alicePub = loadPublicKey(alice.cleartextPublicKey);
const bobPriv = loadPrivateKey(bob.cleartextPrivateKey, bob.cleartextPublicKey);
const bobPub = loadPublicKey(bob.cleartextPublicKey);

// Mutual ECDH: shared secret should match in both directions.
const sharedFromAlice = diffieHellman({ publicKey: bobPub, privateKey: alicePriv });
const sharedFromBob = diffieHellman({ publicKey: alicePub, privateKey: bobPriv });
log(`\n[roundtrip] ECDH shared secret (Alice→Bob): ${sharedFromAlice.toString("hex").slice(0, 32)}…`);
log(`[roundtrip] ECDH shared secret (Bob→Alice): ${sharedFromBob.toString("hex").slice(0, 32)}…`);
const ecdhMatches = sharedFromAlice.equals(sharedFromBob);
log(`[roundtrip] ECDH agreement: ${ecdhMatches ? "✅ MATCH" : "❌ MISMATCH"}`);

if (!ecdhMatches) {
  console.error("ECDH didn't agree — keys aren't compatible.");
  process.exit(1);
}

// Derive a 32-byte symmetric key from the shared secret via HKDF-SHA256.
// Salt + info are arbitrary for this self-test (Snap's real values are TBC).
const salt = Buffer.from("snapcap-fidelius-selftest");
const info = Buffer.from("aes-256-gcm");
const symmetricKey = Buffer.from(
  hkdfSync("sha256", sharedFromAlice, salt, info, 32),
);

// Alice encrypts a message for Bob.
const plaintext = "hello bob, the snap is real 🦣";
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", symmetricKey, iv);
const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const authTag = cipher.getAuthTag();
log(`\n[roundtrip] encrypted: ${ct.byteLength}B + ${authTag.byteLength}B tag`);

// Bob decrypts using ECDH from his side.
const symmetricKey2 = Buffer.from(
  hkdfSync("sha256", sharedFromBob, salt, info, 32),
);
const decipher = createDecipheriv("aes-256-gcm", symmetricKey2, iv);
decipher.setAuthTag(authTag);
const recovered = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
log(`[roundtrip] decrypted: "${recovered}"`);
log(`[roundtrip] match: ${recovered === plaintext ? "✅" : "❌"}`);

if (recovered !== plaintext) {
  process.exit(1);
}

log(`\n[roundtrip] 🎉 round-trip success — WASM-minted Fidelius keys interoperate with node:crypto`);
process.exit(0);
