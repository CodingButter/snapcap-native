/**
 * Experiment 1: does the WASM's createSharedSecretKeys produce the same
 * bytes as node:crypto's diffieHellman for the same P-256 keypair?
 *
 * If yes → Fidelius uses standard ECDH; we already match the primitive.
 * If no  → the WASM hashes/KDFs the raw shared point before returning.
 *           we need to figure out what extra step (HKDF? raw hash?)
 *           and replicate it.
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from "node:crypto";
import { mintFideliusIdentity } from "../src/auth/fidelius-mint.ts";

const log = (s: string): void => { process.stderr.write(s + "\n"); };

log("[ecdh] minting Alice…");
const alice = await mintFideliusIdentity();
log("[ecdh] minting Bob…");
const bob = await mintFideliusIdentity();

// Reach into the WASM via the debug hook installed by fidelius-mint
// when SNAPCAP_EXPOSE_FIDELIUS_MODULE=1.
const Module = (globalThis as unknown as { __snapcap_fidelius_module?: Record<string, unknown> }).__snapcap_fidelius_module;
if (!Module) {
  log("[ecdh] re-run with SNAPCAP_EXPOSE_FIDELIUS_MODULE=1 to expose the WASM Module");
  process.exit(2);
}

const km = Module.e2ee_E2EEKeyManager as Record<string, Function>;
log(`[ecdh] km.createSharedSecretKeys: argCount=${(km.createSharedSecretKeys as { argCount?: number }).argCount}`);

// Re-bake raw keyInfo objects exactly as the WASM produced them — no
// toBytes flattening — since Embind's value-object binding probably
// keys on the exact shape it emits.
const km2 = Module.e2ee_E2EEKeyManager as Record<string, Function>;
const aliceRaw = (km2.generateKeyInitializationRequest as Function)(1) as { keyInfo: unknown };
const bobRaw = (km2.generateKeyInitializationRequest as Function)(1) as { keyInfo: unknown };
log(`\n[ecdh] aliceRaw keyInfo shape: ${JSON.stringify(aliceRaw.keyInfo).slice(0, 200)}…`);

// Try various input shapes — the function takes 2 args but we don't yet
// know the EmVal-typed shape it expects.
const tries: Array<{ label: string; args: [unknown, unknown] }> = [
  // raw keyInfo (WASM-original shape)
  { label: "raw keyInfo objects", args: [aliceRaw.keyInfo, bobRaw.keyInfo] },
  // raw keyInfo.identity
  { label: "raw keyInfo.identity", args: [(aliceRaw.keyInfo as { identity: unknown }).identity, (bobRaw.keyInfo as { identity: unknown }).identity] },
  // ours = full tentative key, theirs = FriendDeviceKey shape (pub + version only)
  {
    label: "tentative + FriendDeviceKey",
    args: [
      (aliceRaw.keyInfo as { identity: unknown }).identity,
      { publicKey: bob.cleartextPublicKey, version: bob.version },
    ],
  },
  // ours: my (priv,pub) only — theirs: their pub + version
  {
    label: "{priv,pub,version} + {pub,version}",
    args: [
      { cleartextPrivateKey: alice.cleartextPrivateKey, cleartextPublicKey: alice.cleartextPublicKey, version: alice.version },
      { publicKey: bob.cleartextPublicKey, version: bob.version },
    ],
  },
  // Maybe arg 0 is a version enum (uint), arg 1 is the friend key
  {
    label: "(int=1, FriendDeviceKey)",
    args: [1, { publicKey: bob.cleartextPublicKey, version: bob.version }],
  },
  {
    label: "(int=1, raw keyInfo.identity)",
    args: [1, (aliceRaw.keyInfo as { identity: unknown }).identity],
  },
  // KeyVersion enum + WebKey + DeviceKey ?
  {
    label: "({TentativeWebKey}, {FriendDeviceKey})",
    args: [
      aliceRaw.keyInfo,
      { publicKey: bob.cleartextPublicKey, version: bob.version },
    ],
  },
  // Both friend-key shape — maybe createSharedSecretKeys takes
  // (myFriendDeviceKey, theirFriendDeviceKey)
  {
    label: "(FriendDeviceKey, FriendDeviceKey)",
    args: [
      { publicKey: alice.cleartextPublicKey, version: alice.version },
      { publicKey: bob.cleartextPublicKey, version: bob.version },
    ],
  },
  // Try 1: pass the full keyInfo.identity object (matches what generate
  // returns nested inside the result).
  {
    label: "keyInfo.identity objects",
    args: [
      { cleartextPrivateKey: alice.cleartextPrivateKey, cleartextPublicKey: alice.cleartextPublicKey, identityKeyId: { data: alice.identityKeyId }, version: alice.version },
      { cleartextPrivateKey: bob.cleartextPrivateKey, cleartextPublicKey: bob.cleartextPublicKey, identityKeyId: { data: bob.identityKeyId }, version: bob.version },
    ],
  },
  // Try 2: pass the raw 32-byte private and 65-byte public bytes.
  {
    label: "(privBytes, pubBytes)",
    args: [alice.cleartextPrivateKey, bob.cleartextPublicKey],
  },
  // Try 3: pass {cleartextPublicKey} only — possibly takes pub keys for both
  // and figures out shared from your stored identity.
  {
    label: "(alicePub, bobPub)",
    args: [alice.cleartextPublicKey, bob.cleartextPublicKey],
  },
];

for (const t of tries) {
  log(`\n[ecdh] try: ${t.label}`);
  try {
    const r = (km.createSharedSecretKeys as Function)(t.args[0], t.args[1]);
    if (r && typeof r === "object") {
      log(`  → returned object with keys: ${Object.keys(r).join(", ")}`);
      // dump first few values
      for (const k of Object.keys(r).slice(0, 5)) {
        const v = (r as Record<string, unknown>)[k];
        if (v instanceof Uint8Array) {
          log(`     ${k}: Uint8Array(${v.byteLength}) ${Buffer.from(v).toString("hex").slice(0, 64)}…`);
        } else if (Array.isArray(v) || (v && typeof v === "object")) {
          const bytes = new Uint8Array(Object.values(v as Record<string, number>));
          log(`     ${k}: object, ${bytes.byteLength}B ${Buffer.from(bytes).toString("hex").slice(0, 64)}…`);
        } else {
          log(`     ${k}: ${v}`);
        }
      }
    } else {
      log(`  → ${typeof r}: ${r}`);
    }
  } catch (e) {
    log(`  threw: ${(e as Error).message.slice(0, 200)}`);
  }
}

// Standard ECDH via node:crypto — convert WASM keys to KeyObject form.
function loadPrivateKey(privScalar: Uint8Array, pubBytes: Uint8Array) {
  return createPrivateKey({
    key: {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: b64u(pubBytes.slice(1, 33)),
      y: b64u(pubBytes.slice(33, 65)),
      d: b64u(privScalar),
    },
    format: "jwk",
  });
}
function loadPublicKey(pubBytes: Uint8Array) {
  return createPublicKey({
    key: {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: b64u(pubBytes.slice(1, 33)),
      y: b64u(pubBytes.slice(33, 65)),
    },
    format: "jwk",
  });
}
function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const standardEcdh = diffieHellman({ privateKey: loadPrivateKey(alice.cleartextPrivateKey, alice.cleartextPublicKey), publicKey: loadPublicKey(bob.cleartextPublicKey) });
log(`\n[ecdh] node:crypto diffieHellman → ${standardEcdh.byteLength}B ${standardEcdh.toString("hex").slice(0, 64)}…`);

process.exit(0);
