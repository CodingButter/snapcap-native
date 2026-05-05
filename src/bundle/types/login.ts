/**
 * WebLoginService wire shapes — the constructor for the accounts-bundle
 * client (`WebLoginServiceClientImpl`, accounts module 13150) and the
 * 2-step request / response envelopes accepted by `WebLogin`.
 *
 * Step 1 carries the loginIdentifier (username/email/phone); step 2
 * carries the password challenge answer. Both share the
 * `webLoginHeaderBrowser` envelope (attestation + arkose token).
 */
import type { UnaryFn } from "./shared.ts";

/**
 * `WebLoginServiceClientImpl` constructor — accounts module 13150.
 * Takes an `{unary}` rpc transport and exposes a `WebLogin` method.
 *
 * @internal Bundle wire-format type.
 */
export type LoginClientCtor = new (rpc: { unary: UnaryFn }) => {
  WebLogin(req: WebLoginRequest): Promise<WebLoginResponse>;
};

/**
 * `WebLoginRequest` partial — accepted by the bundle's ts-proto
 * `WebLoginRequest.fromPartial`. The two real call sites (login step 1 vs
 * step 2) populate disjoint subsets of the optional fields, so everything
 * past `webLoginHeaderBrowser` is `?`.
 *
 * @internal Bundle wire-format type.
 */
export type WebLoginRequest = {
  webLoginHeaderBrowser: {
    authenticationSessionPayload: Uint8Array;
    attestationPayload: Uint8Array;
    arkoseToken: string;
    ssoClientId: string;
    continueParam: string;
    multiUser: boolean;
    captchaPayload: { provider: number; payload: string; errorMessage: string };
  };
  /** Step-1 only: ts-proto oneof {`username` | `email` | `phone`}. */
  loginIdentifier?:
    | { $case: "username"; username: string }
    | { $case: "email"; email: string }
    | { $case: "phone"; phone: string };
  /** Step-2 only: nested challenge answer wrapper. */
  challengeAnswer?: {
    challengeAnswer: {
      $case: "passwordChallengeAnswer";
      passwordChallengeAnswer: { password: string };
    };
  };
};

/**
 * `WebLoginResponse` decoded shape — only the fields the SDK reads on the
 * success / step-1-challenge paths are typed; the rest stays `unknown`.
 *
 * @internal Bundle wire-format type.
 */
export type WebLoginResponse = {
  /** 1 = success on step 2; other values flag protocol-level failures. */
  statusCode?: number;
  /** Echoed back unchanged on step 2. */
  authenticationSessionPayload?: Uint8Array;
  /** ts-proto oneof — `errorData` | `challengeData` | (other future cases). */
  payload?:
    | {
        $case: "challengeData";
        challengeData?: {
          challenge?: { $case: string; [k: string]: unknown };
        };
      }
    | { $case: "errorData"; errorData?: unknown }
    | { $case?: string; [k: string]: unknown };
  [k: string]: unknown;
};
