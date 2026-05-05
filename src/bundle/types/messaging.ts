/**
 * Bundle-realm WASM messaging session shapes — the per-method `Session`
 * record and the closure-private `SendsModule` (chat module 56639) that
 * wraps every send / fetch / lifecycle / snap-interaction verb. The api
 * layer drives these directly via the registry getters.
 */
import type { ConversationRef } from "./shared.ts";
import type { CapturedSnap, SnapDestinations } from "./snap.ts";
import type { FetchConversationWithMessagesResult } from "./conversations.ts";

/**
 * Bundle-realm WASM messaging session — keys are method names, values
 * are Embind functions.
 *
 * @internal Bundle wire-format type.
 */
export type Session = Record<string, Function>;

/**
 * Module 56639 sends/receives surface (chat main byte 4928786) — the
 * bundle-private letter pair exports for every send / fetch / lifecycle /
 * snap-interaction verb the SDK wraps.
 *
 * @internal Bundle wire-format type.
 */
export interface SendsModule {
  pn(s: Session, c: ConversationRef, t: string, q?: unknown, a?: unknown, b?: boolean): Promise<void>;
  E$(s: Session, c: ConversationRef[], m: unknown[], o?: unknown): Promise<void>;
  HM(s: Session, d: SnapDestinations, c: CapturedSnap, o?: unknown, q?: unknown, i?: unknown[]): Promise<void>;
  Sd(s: Session, c: ConversationRef, m: bigint, d: number): Promise<void>;
  Mw(s: Session, c: ConversationRef, conversationType: number): Promise<void>;
  ON(s: Session, c: ConversationRef, conversationType: number): Promise<void>;
  zM(s: Session, c: ConversationRef): Promise<void>;
  H7(s: Session, c: ConversationRef): Promise<void>;
  zA(s: Session, c: ConversationRef): Promise<void>;
  eh(s: Session, c: ConversationRef, participants: unknown): Promise<void>;
  cK(s: Session, a: unknown, b: unknown, c: unknown, d: unknown): Promise<unknown>;
  wh(s: Session, c: ConversationRef): Promise<unknown>;
  ik(s: Session, c: ConversationRef): Promise<unknown>;
  QL(s: Session, c: ConversationRef): Promise<unknown>;
  NB(s: Session, participantIds: unknown): Promise<unknown[]>;
  Kz(s: Session, ident: unknown, type: number, minVersion: unknown, ...rest: unknown[]): Promise<unknown>;
  CK(s: Session, triggerType: number): Promise<void>;
  Gx(s: Session, x: unknown, n: unknown): Promise<unknown>;
  V4(s: Session): Promise<unknown>;
  uk(s: Session, c: ConversationRef): Promise<FetchConversationWithMessagesResult>;
  Gq(s: Session, c: ConversationRef, before: unknown): Promise<FetchConversationWithMessagesResult>;
  A_(s: Session, c: ConversationRef, messageId: bigint): Promise<unknown>;
  cr(s: Session, c: ConversationRef, messageIds: unknown[]): Promise<void>;
  Io(s: Session, c: ConversationRef, messageId: unknown): Promise<void>;
  nc(s: Session, c: ConversationRef, messageId: unknown, content: unknown): Promise<void>;
  QJ(s: Session, c: ConversationRef, messageId: unknown, reactionIntent: unknown, reactionId: unknown): Promise<void>;
  et(s: Session, c: ConversationRef, messageId: unknown, reactionId: unknown): Promise<void>;
  CS(s: Session, c: ConversationRef, settings: unknown): Promise<void>;
  yU(s: Session, c: ConversationRef, retentionMode: unknown, retentionDuration: unknown): Promise<void>;
  xJ(s: Session, c: ConversationRef, title: string): Promise<void>;
  oS(s: Session, c: ConversationRef, callInfo: unknown, quoted?: unknown, analytics?: unknown): Promise<void>;
  wb(s: Session, c: ConversationRef, compositeStoryId: unknown, analytics?: unknown): Promise<void>;
  K7(s: Session, c: ConversationRef, text: string, originalSnapdoc: unknown, snapStoryId?: unknown, analytics?: unknown): Promise<void>;
  kW(s: Session, userIds: unknown): Promise<Map<unknown, unknown>>;
  pI(s: Session, snapId: unknown, conversationId: ConversationRef): Promise<void>;
  _z(s: Session, snapId: unknown, conversationId: ConversationRef): Promise<void>;
  iE(s: Session, snapId: unknown): Promise<void>;
  ST(s: Session, snapId: unknown, conversationId: ConversationRef): Promise<void>;
  fb(s: Session, snapId: unknown, downloadStatus: unknown, conversationId: ConversationRef): Promise<void>;
}
