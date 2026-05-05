/**
 * Cold-path 2-step WebLogin via the bundle's `WebLoginServiceClientImpl`.
 *
 * Mirrors the working flow from `scripts/test-bundle-login.ts`:
 *
 *   1. Force-eval module 13150 to fire the `__SNAPCAP_LOGIN_CLIENT_IMPL`
 *      source-patch (the patch runs as a top-level statement inside the
 *      module factory; nothing else imports it during bundle init).
 *   2. Build a unary fn via the accounts bundle's `unaryFactory`
 *      (module 98747) — wraps `_.grpc.unary` with metrics + auth-error
 *      handling.
 *   3. Construct `WebLoginServiceClientImpl` once, run step 1
 *      (identifier + attestation) → step 2 (password answer).
 *
 * On success the auth-session cookies land in the jar via the XHR
 * shim's cookie-container patch.
 *
 * @internal
 */
import { getKameleon } from "../../bundle/accounts-loader.ts";
import { loginClient } from "../../bundle/register/index.ts";
import { getOrCreateJar } from "../../shims/cookie-jar.ts";
import type { UnaryFn, WebLoginRequest, WebLoginResponse } from "../../bundle/types/index.ts";
import type { ClientContext } from "../_context.ts";
import { activeIdentifier, type Credentials } from "../../types.ts";

/** Webpack module id for the WebLoginRequest/Response codec (accounts bundle). */
const MOD_WEB_LOGIN_PROTO = "29517"; // unused at runtime — kept for parity with the legacy `src/auth/login.ts`; codecs are owned by submitLogin's ctor.

/** unaryFactory module id (accounts bundle). */
const MOD_UNARY_FACTORY = "98747";

/**
 * Cold path: drive the bundle's own 2-step `WebLogin` via the
 * source-patched `WebLoginServiceClientImpl`. Mirrors the working flow
 * from `scripts/test-bundle-login.ts`.
 *
 * On success the auth-session cookies land in the jar via the XHR
 * shim's cookie-container patch.
 *
 * @internal
 */
export async function fullLogin(
  ctx: ClientContext,
  opts: { credentials: Credentials },
): Promise<void> {
  // Pull the active identifier (username | email | phone) — Snap's
  // WebLogin proto loginIdentifier is a oneof of the three. The
  // attestation also gets bound to whichever identifier the consumer
  // passed in (kameleon.finalize takes the identifier as its input).
  const id = activeIdentifier(opts.credentials);
  const { ctx: kameleon, wreq } = await getKameleon(ctx.sandbox, { page: "www_login" });

  // Force-eval module 13150 to fire the WebLoginServiceClientImpl
  // source-patch (the patch runs as a top-level statement inside the
  // module factory; nothing else imports it during bundle init).
  wreq("13150");

  // Build the unary fn via the bundle's unaryFactory (module 98747).
  // This wraps `_.grpc.unary` (improbable-eng) with metrics + auth-error
  // handling. Sandbox-realm Function — invoke against the bundle's
  // LoginClient ctor below.
  const factoryMod = wreq(MOD_UNARY_FACTORY) as { unaryFactory: Function };
  const unary = factoryMod.unaryFactory({
    onUnauthorizedError: () => {
      /* expected during logged-out 2-step; ignore */
    },
    metricsPrefix: "snapcap-auth",
    hostURL: "https://accounts.snapchat.com",
    userAgent: ctx.userAgent,
  }) as UnaryFn;

  // Construct the bundle's `WebLoginServiceClientImpl` once and reuse
  // for both 2-step calls.
  const LoginCtor = loginClient(ctx.sandbox);
  const login = new LoginCtor({ unary });
  const submitLogin = (req: WebLoginRequest): Promise<WebLoginResponse> => login.WebLogin(req);

  // Build the request envelopes using the sandbox's TextEncoder (so the
  // bundle's `instanceof Uint8Array` cross-realm checks pass).
  const TextEncoderCtor = ctx.sandbox.runInContext("TextEncoder") as typeof TextEncoder;
  const enc = new TextEncoderCtor();
  const attestation = await kameleon.finalize(id.value);

  const headerBrowserBase = {
    authenticationSessionPayload: new Uint8Array(),
    attestationPayload: enc.encode(attestation),
    arkoseToken: "",
    ssoClientId: "",
    continueParam:
      "/accounts/sso?client_id=web-calling-corp--prod&referrer=https%3A%2F%2Fwww.snapchat.com%2Fweb",
    multiUser: false,
    captchaPayload: { provider: 0, payload: "", errorMessage: "" },
  };

  // Step 1: identifier + attestation.
  const r1 = await submitLogin({
    webLoginHeaderBrowser: headerBrowserBase,
    // Snap's WebLogin loginIdentifier is a ts-proto oneof keyed by `$case`.
    // Build the variant matching whichever identifier the consumer passed.
    loginIdentifier:
      id.type === "username" ? { $case: "username", username: id.value } :
      id.type === "email"    ? { $case: "email",    email:    id.value } :
                               { $case: "phone",    phone:    id.value },
  });
  const r1Payload = r1.payload as
    | { $case?: string; challengeData?: { challenge?: { $case?: string } } }
    | undefined;
  if (r1Payload?.$case === "errorData") {
    throw new Error(`WebLogin step 1 errorData: ${JSON.stringify(r1.payload)}`);
  }
  if (
    r1Payload?.$case !== "challengeData" ||
    r1Payload.challengeData?.challenge?.$case !== "passwordChallenge"
  ) {
    const innerCase = r1Payload?.challengeData?.challenge?.$case ?? "(none)";
    throw new Error(
      `WebLogin step 1 unexpected payload: outer=${r1Payload?.$case ?? "(none)"} inner=${innerCase}`,
    );
  }
  const sessionPayload = r1.authenticationSessionPayload as Uint8Array;

  // Step 2: password answer.
  const r2 = await submitLogin({
    webLoginHeaderBrowser: { ...headerBrowserBase, authenticationSessionPayload: sessionPayload },
    challengeAnswer: {
      challengeAnswer: {
        $case: "passwordChallengeAnswer",
        passwordChallengeAnswer: { password: opts.credentials.password },
      },
    },
  });
  const r2Payload = r2.payload as { $case?: string } | undefined;
  if (r2Payload?.$case === "errorData") {
    throw new Error(`WebLogin step 2 errorData: ${JSON.stringify(r2.payload)}`);
  }
  if (r2.statusCode !== 1) {
    throw new Error(`WebLogin step 2 statusCode=${r2.statusCode}, expected 1`);
  }

  // Verify the session cookie landed. The bundle's XHR-driven fetch
  // writes to the SHIM's jar (via `installCookieContainer`), not the
  // `CookieJarStore` wrapper's instance — read from the shared jar.
  const sharedJar = getOrCreateJar(ctx.dataStore);
  const authCookie = (await sharedJar.getCookies("https://accounts.snapchat.com")).find(
    (c) => c.key === "__Host-sc-a-auth-session",
  );
  if (!authCookie) {
    throw new Error("WebLogin succeeded protocol-wise but no __Host-sc-a-auth-session in jar");
  }
  // The shim's jar persists synchronously via `persistJar` on every write;
  // no flush needed here. ctx.jar.flush() would re-serialize the STALE
  // wrapper jar and overwrite what the shim landed.
}

// `MOD_WEB_LOGIN_PROTO` is declared above for documentation alignment
// with the legacy `src/auth/login.ts`; not currently referenced because
// the bundle's `WebLoginServiceClientImpl` ctor (returned by
// `loginClient(ctx.sandbox)`) owns the codec internally. Keep the
// reference live so an unused-vars lint pass doesn't strip the doc note.
void MOD_WEB_LOGIN_PROTO;
