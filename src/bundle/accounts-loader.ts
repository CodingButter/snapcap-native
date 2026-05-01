/**
 * Native kameleon attestation generator.
 *
 * Loads the accounts bundle into a shimmed Node global, force-requires the
 * Emscripten Module factory (webpack module 58116), wires in the runtime
 * dependencies that the bundle's `createModule` wrapper would otherwise
 * attach (Graphene metrics stub, page name, BUILD_VERSION, UAParser, the
 * gRPC client for snap.security.WebAttestationService), then exposes the
 * `AttestationSession.instance().finalize(identifier)` flow.
 *
 * The returned token is the same blob that `useAttestationWithMetrics`
 * yields in the browser, ready to drop into a WebLoginService request as
 * `webLoginHeaderBrowser.attestationPayload` (UTF-8 bytes of the string).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "../shims/sandbox.ts";
import { installWebpackCapture } from "../shims/webpack-capture.ts";
import { ensureBundle } from "./download.ts";

export type KameleonOpts = {
  /** Root of vendor/snap-bundle (defaults to packages/native/vendor/snap-bundle). */
  bundleDir?: string;
  /** Page identifier kameleon embeds into the token ("login", "signup", "www_login", …). */
  page?: string;
  /** Emit verbose tracing (logs every Embind glue call to stdout). */
  trace?: boolean;
};

export type KameleonContext = {
  /** Generate an attestation token bound to `identifier` (username/email/phone). */
  finalize(identifier: string): Promise<string>;
};

/**
 * Boot the kameleon Module once and return a finalize() function.
 *
 * The first call costs ~1–2s and ~5MB of JS eval + an 814KB WASM
 * instantiate. We cache that work in a process-wide singleton: subsequent
 * calls (including from different SnapcapClient instances) reuse the same
 * Module + the same captured webpack require.
 *
 * Multi-account is fine: AttestationSession.instance() is a Module-level
 * singleton, but `finalize(identifier)` rebinds the username on each call —
 * different accounts get different tokens through the same Module.
 */
type BootedKameleon = {
  ctx: KameleonContext;
  wreq: { (id: string): unknown; m: Record<string, Function> };
};
/**
 * Per-Sandbox kameleon boot. Cached on the Sandbox instance — a fresh
 * Sandbox boots its own kameleon Module so two `SnapcapClient` instances
 * never share kameleon state.
 *
 * `sandbox` is required: the kameleon WASM is instantiated INTO this
 * sandbox's vm.Context, and the cache lives on the sandbox so each
 * client gets its own Module + finalize() context.
 */
export async function getKameleon(sandbox: Sandbox, opts: KameleonOpts = {}): Promise<BootedKameleon> {
  if (!sandbox.kameleonBoot) {
    sandbox.kameleonBoot = bootKameleonOnce(sandbox, opts);
  }
  return sandbox.kameleonBoot as Promise<BootedKameleon>;
}

export async function bootKameleon(sandbox: Sandbox, opts: KameleonOpts = {}): Promise<KameleonContext> {
  const { ctx } = await getKameleon(sandbox, opts);
  return ctx;
}

async function bootKameleonOnce(sandbox: Sandbox, opts: KameleonOpts): Promise<BootedKameleon> {
  const bundleDir = opts.bundleDir ?? defaultBundleDir();
  await ensureBundle(bundleDir);
  installWebpackCapture(sandbox);

  const accountsDir = join(
    bundleDir,
    "static.snapchat.com",
    "accounts",
    "_next",
    "static",
    "chunks",
  );
  if (!existsSync(accountsDir)) {
    throw new Error(`accounts bundle not found at ${accountsDir} — run scripts/download-bundle.sh first`);
  }

  // Load order: webpack runtime first (so it can install itself), then
  // polyfills/framework/main, then numbered chunks alphabetically, then the
  // _app page bundle that pulls in 91353 (kameleon wrapper) and 58116
  // (kameleon factory itself).
  const filesInOrder = [
    "webpack-5c0e3c9fd3281330.js",
    "polyfills-42372ed130431b0a.js",
    "framework-41b02394b273386f.js",
    "main-0ebbe566bb0a52ef.js",
  ];
  for (const f of readdirSync(accountsDir).sort()) {
    if (!f.endsWith(".js") || filesInOrder.includes(f)) continue;
    filesInOrder.push(f);
  }
  filesInOrder.push("pages/_app-7ccf4584432ba8ad.js");

  for (const rel of filesInOrder) {
    const path = join(accountsDir, rel);
    let src = readFileSync(path, "utf8");
    // Patch the webpack runtime's IIFE so its closure-private `p`
    // (__webpack_require__) leaks to the sandbox Window. Without this we
    // can't call into modules by id. Note: `globalThis` here resolves to
    // the sandbox Window because the patched source is eval'd via
    // sandbox.runInContext.
    if (rel.startsWith("webpack-")) {
      src = src.replace(
        "p.m=s,p.amdO={}",
        "globalThis.__snapcap_p=p,p.m=s,p.amdO={}",
      );
    }
    // Expose `WebLoginServiceClientImpl` (`L`) from accounts module 13150 to
    // globalThis. Same pattern as the chat-bundle Fi/Ni/jz patches: we keep
    // the original `class L` binding intact (so the rest of the module body
    // resolves it normally) and inject a sibling assignment that hangs the
    // class onto a sandbox-global symbol after its body lands. Reaching this
    // class lets us instantiate a login client outside React context — the
    // React tree never has to mount.
    //
    // The anchor is the boundary between class L's last method binding and
    // the `let D={serviceName:"snapchat.janus.api.WebLoginService"}` that
    // immediately follows. Inserting an assignment here runs once at module
    // eval time, so __SNAPCAP_LOGIN_CLIENT_IMPL is set BEFORE we ever look
    // for it. Also exposes `M` (the WebLogin descriptor / "Desc") on the
    // same anchor so a host-realm caller can decode/encode requests without
    // re-deriving the service shape.
    if (rel === "pages/_app-7ccf4584432ba8ad.js") {
      const anchor = "}let D={serviceName:\"snapchat.janus.api.WebLoginService\"}";
      if (src.includes(anchor)) {
        src = src.replace(
          anchor,
          "}globalThis.__SNAPCAP_LOGIN_CLIENT_IMPL=L;let D={serviceName:\"snapchat.janus.api.WebLoginService\"}",
        );
      } else {
        throw new Error("accounts-bundle: WebLoginServiceClientImpl source-patch site missing — bundle version may have shifted");
      }
    }
    // Wrap in an IIFE so module/exports/require are scoped locals matching
    // the shape `new Function(...)(...)` previously gave us. Top-level
    // globalThis still resolves to the sandbox Window.
    //
    // The `\n` before the close matters: Snap's bundles end in a
    // `//# sourceMappingURL=…` line comment with no trailing newline, so
    // a bare `})(…)` continuation gets eaten by the comment.
    const wrapped =
      `(function(module, exports, require) {\n` +
      src +
      `\n})({ exports: {} }, {}, function() { throw new Error("require not available (${rel})"); });`;
    try {
      sandbox.runInContext(wrapped, `accounts:${rel}`);
    } catch {
      // Many top-level Next.js init failures are harmless (e.g. they try
      // to call document.getElementById('__NEXT_DATA__')). Module factories
      // are still registered before the throw.
    }
  }

  const wreq = sandbox.getGlobal<{ (id: string): unknown; m: Record<string, Function> }>("__snapcap_p");
  if (!wreq) {
    throw new Error("webpack runtime did not expose __snapcap_p — patch may have failed");
  }

  // 58116 = kameleon Emscripten Module factory.
  const kamMod = wreq("58116") as { default?: Function } & Record<string, unknown>;
  const factory = (kamMod.default ?? kamMod) as Function;

  const wasmPath = join(
    bundleDir,
    "static.snapchat.com",
    "accounts",
    "_next",
    "static",
    "media",
    "kameleon.077113e1.wasm",
  );
  const wasmBytes = readFileSync(wasmPath);

  // Pull supporting deps from the accounts bundle.
  const uaModule = wreq("40243") as { UAParser?: new () => unknown } & {
    default?: { UAParser?: new () => unknown };
  };
  const UAParser = uaModule.UAParser ?? uaModule.default?.UAParser;
  const grpcMod = wreq("94631") as {
    WebAttestationServiceClient?: new (host: string) => unknown;
  };

  const moduleEnv: Record<string, unknown> = {
    instantiateWasm: (
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance, mod?: WebAssembly.Module) => void,
    ): unknown => {
      if (opts.trace) wrapEmscriptenImports(imports);
      WebAssembly.instantiate(wasmBytes, imports).then((res) => {
        successCallback(res.instance, res.module);
      });
      return {};
    },
    onAbort: (reason: unknown) => {
      throw new Error(`kameleon module aborted: ${String(reason)}`);
    },
    print: () => {},
    printErr: () => {},
    locateFile: (name: string) => name,
    page: opts.page ?? "www_login",
    version: "4.0.3",
    Graphene: {
      increment: () => {},
      addTimer: () => {},
    },
    UAParserInstance: UAParser ? new UAParser() : undefined,
    webAttestationServiceClientInstance: grpcMod.WebAttestationServiceClient
      ? new grpcMod.WebAttestationServiceClient("https://session.snapchat.com")
      : undefined,
  };

  const factoryResult = factory(moduleEnv);
  const mod = (
    factoryResult && typeof (factoryResult as { then?: Function }).then === "function"
      ? await factoryResult
      : factoryResult
  ) as Record<string, unknown>;

  const AS = mod.AttestationSession as {
    instance: () => { finalize: (s: string) => Promise<string> | string };
  };

  const ctx: KameleonContext = {
    async finalize(identifier: string): Promise<string> {
      const session = AS.instance();
      const r = (session as { finalize: (s: string) => unknown }).finalize.call(session, identifier);
      const tok =
        r && typeof (r as { then?: Function }).then === "function"
          ? await (r as Promise<unknown>)
          : r;
      if (typeof tok !== "string") {
        throw new Error(`kameleon.finalize returned non-string: ${typeof tok}`);
      }
      return tok;
    },
  };
  return { ctx, wreq };
}

function defaultBundleDir(): string {
  return join(
    import.meta.dirname,
    "..",
    "..",
    "vendor",
    "snap-bundle",
  );
}

/** Verbose Embind tracing (used when opts.trace is true). */
function wrapEmscriptenImports(imports: WebAssembly.Imports): void {
  const env = imports.env as Record<string, Function>;
  let memBuf: ArrayBuffer | null = null;
  const decode = (ptr: number): string => {
    if (!memBuf) return `<${ptr}>`;
    const u8 = new Uint8Array(memBuf);
    let end = ptr;
    while (end < u8.length && u8[end] !== 0) end++;
    return new TextDecoder().decode(u8.subarray(ptr, end));
  };
  for (const name of [
    "_emval_get_property",
    "_emval_get_global",
    "_emval_get_module_property",
    "_emval_call_method",
    "_emval_new_cstring",
  ]) {
    const orig = env[name];
    if (typeof orig !== "function") continue;
    env[name] = function (...args: unknown[]) {
      if (!memBuf) {
        const wmem = (imports as unknown as { env: { memory?: WebAssembly.Memory } }).env.memory;
        if (wmem) memBuf = wmem.buffer;
      }
      const r = orig(...args);
      const cs = typeof args[0] === "number" ? decode(args[0]) : "";
      console.log(`[kameleon.trace] ${name}(${args.join(", ")}) "${cs}" → ${r}`);
      return r;
    };
  }
}
