/**
 * Multi-instance isolation guards for the three formerly-singleton shim
 * modules:
 *
 *   - `shims/webpack-capture.ts` — captured-modules / originals / hints
 *     accumulators MUST be per-Sandbox (not module-level).
 *   - `shims/cookie-container.ts` — happy-dom CookieContainer dispatch
 *     MUST resolve to a per-Sandbox (jar, store) binding (not a global
 *     `activeJar` / `activeStore`).
 *   - `shims/runtime.ts` — `installShims()` / `getSandbox()` were removed
 *     in favour of constructing `Sandbox` directly per-instance.
 *
 * The bug: with module-level singletons, the SECOND `SnapcapClient`
 * silently inherits the FIRST sandbox's accumulators / cookie jar →
 * cross-tenant data leak. These checks pin the per-Sandbox isolation so a
 * future regression fails loudly here (instead of silently in production).
 *
 * No real authentication happens — we just construct two clients (or two
 * Sandboxes), look at the per-instance state, and assert the references
 * are distinct.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapcapClient } from "../../src/client.ts";
import { Sandbox } from "../../src/shims/sandbox.ts";
import { FileDataStore } from "../../src/storage/data-store.ts";
import { installWebpackCapture } from "../../src/shims/webpack-capture.ts";
import { getOrCreateJar } from "../../src/shims/cookie-jar.ts";

const UA_PERDYJAMIE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const UA_JAMIELILLEE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function newTmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapcap-iso-"));
  return join(dir, "store.json");
}

describe("multi-instance Sandbox isolation", () => {
  test("two SnapcapClient instances own disjoint Sandboxes", () => {
    const dsA = new FileDataStore(newTmpStorePath());
    const dsB = new FileDataStore(newTmpStorePath());

    const clientA = new SnapcapClient({
      dataStore: dsA,
      browser: { userAgent: UA_PERDYJAMIE },
      credentials: { username: "perdyjamie", password: "<not used>" },
    });
    const clientB = new SnapcapClient({
      dataStore: dsB,
      browser: { userAgent: UA_JAMIELILLEE },
      credentials: { username: "jamielillee", password: "<not used>" },
    });

    // The Sandbox field is private on SnapcapClient; reach it as a casted
    // "internal-shape" for assertion purposes only — the production code
    // path never touches this surface.
    const sbA = (clientA as unknown as { sandbox: Sandbox }).sandbox;
    const sbB = (clientB as unknown as { sandbox: Sandbox }).sandbox;

    expect(sbA).toBeDefined();
    expect(sbB).toBeDefined();
    expect(sbA).not.toBe(sbB);
    // vm.Context realm boundary — every isolation guarantee in the SDK
    // pivots on this being a fresh context per Sandbox.
    expect(sbA.context).not.toBe(sbB.context);
    expect(sbA.window).not.toBe(sbB.window);
  });

  test("webpack-capture maps are per-Sandbox (not shared)", () => {
    const dsA = new FileDataStore(newTmpStorePath());
    const dsB = new FileDataStore(newTmpStorePath());
    const sbA = new Sandbox({ dataStore: dsA, userAgent: UA_PERDYJAMIE });
    const sbB = new Sandbox({ dataStore: dsB, userAgent: UA_JAMIELILLEE });

    const capA = installWebpackCapture(sbA);
    const capB = installWebpackCapture(sbB);

    // Prior bug: the second `installWebpackCapture` returned the first
    // sandbox's accumulator (module-level `installed` cache), so capA.modules
    // === capB.modules. With per-Sandbox state this MUST be false.
    expect(capA.modules).not.toBe(capB.modules);
    expect(capA.originals).not.toBe(capB.originals);
    expect(capA.hints).not.toBe(capB.hints);

    // Idempotency on the SAME sandbox still returns the SAME maps.
    const capA2 = installWebpackCapture(sbA);
    expect(capA2.modules).toBe(capA.modules);
    expect(capA2.originals).toBe(capA.originals);
    expect(capA2.hints).toBe(capA.hints);

    // Cross-write check: stuffing into sbA's modules MUST NOT show up on
    // sbB's modules.
    capA.modules.set("CANARY_ONLY_IN_A", { from: "A" });
    expect(capB.modules.has("CANARY_ONLY_IN_A")).toBe(false);

    // Also: sbA.webpackCapture / sbB.webpackCapture point at the right
    // per-instance state.
    expect(sbA.webpackCapture).toBe(capA);
    expect(sbB.webpackCapture).toBe(capB);
    expect(sbA.webpackCapture).not.toBe(sbB.webpackCapture);
  });

  test("cookie containers / jars are per-Sandbox (not shared)", async () => {
    // Distinct DataStores → distinct jars (jar cache is keyed by store).
    const dsA = new FileDataStore(newTmpStorePath());
    const dsB = new FileDataStore(newTmpStorePath());
    const sbA = new Sandbox({ dataStore: dsA, userAgent: UA_PERDYJAMIE });
    const sbB = new Sandbox({ dataStore: dsB, userAgent: UA_JAMIELILLEE });

    const jarA = getOrCreateJar(dsA);
    const jarB = getOrCreateJar(dsB);
    expect(jarA).not.toBe(jarB);

    // Set distinct cookies via the sandbox `document.cookie` shim — which
    // routes through the same jar as the CookieContainer prototype patch.
    // Cross-realm property access via `window` is sufficient.
    const docA = sbA.document as { cookie: string };
    const docB = sbB.document as { cookie: string };

    docA.cookie = "tenant=A; path=/";
    docB.cookie = "tenant=B; path=/";

    // Read back via the cookie-container path (the one happy-dom uses for
    // outgoing fetch). With per-Sandbox bindings, sbA's CookieContainer
    // resolves to jarA → reads back "tenant=A"; sbB → "tenant=B".
    const cookiesA = await jarA.getCookies("https://www.snapchat.com/");
    const cookiesB = await jarB.getCookies("https://www.snapchat.com/");

    const tenantA = cookiesA.find((c) => c.key === "tenant")?.value;
    const tenantB = cookiesB.find((c) => c.key === "tenant")?.value;
    expect(tenantA).toBe("A");
    expect(tenantB).toBe("B");

    // Cross-write check: sbA's cookies must NOT appear in sbB's jar.
    const sbBHasA = cookiesB.some(
      (c) => c.key === "tenant" && c.value === "A",
    );
    const sbAHasB = cookiesA.some(
      (c) => c.key === "tenant" && c.value === "B",
    );
    expect(sbBHasA).toBe(false);
    expect(sbAHasB).toBe(false);
  });
});

// Best-effort tmpdir cleanup. Bun's test runner doesn't have a global
// teardown hook in older versions; rely on the OS to GC /tmp/snapcap-iso-*
// eventually. Test files are tiny (single store.json each).
process.on("exit", () => {
  // Intentionally empty — listing & rming the per-test dirs would couple
  // this file to its own pathing in fragile ways. /tmp is fair game.
  void rmSync; // keep import if referenced via lint rules
});
