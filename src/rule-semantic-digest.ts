import { createHash } from "node:crypto";
import type { NormalizedRule } from "./schemas/rules.js";

type RuleSemantics = Pick<NormalizedRule, "title" | "ruleGroupId" | "order" | "trigger" | "strict" | "stopProcessing" | "triggers" | "actions">;

const PENDING_MARKER =
  /^\[openclaw-firefly:pending:v1;proposal=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12});digest=([0-9a-f]{64});created=([^;\]]+);expires=([^\]]+)\](?:\n|$)/u;

export interface PendingMarker { proposalId: string; proposalDigest: string; createdAt: string; expiresAt: string; userDescription: string; }

export function parsePendingDescription(description: string | null): PendingMarker | null {
  if (description === null) return null;
  const match = PENDING_MARKER.exec(description);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !isIsoDate(match[3]) || !isIsoDate(match[4])) return null;
  return { proposalId: match[1], proposalDigest: match[2], createdAt: match[3], expiresAt: match[4], userDescription: description.slice(match[0].length) };
}

/** Stable digest of the visible semantics Firefly preserves for a rule. */
export function semanticDigest(rule: RuleSemantics, userDescription: string): string {
  const semantic = {
    title: rule.title, ruleGroupId: rule.ruleGroupId, order: rule.order,
    trigger: rule.trigger, strict: rule.strict, stopProcessing: rule.stopProcessing,
    // Firefly normalizes numeric child orders with hidden user_action triggers in
    // the same sequence. Array position is the observable execution sequence.
    triggers: rule.triggers.map(({ type, value, prohibited, active, stopProcessing }) => ({ type, value, prohibited, active, stopProcessing })),
    actions: rule.actions.map(({ type, value, active, stopProcessing }) => ({ type, value, active, stopProcessing })),
    userDescription,
  };
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

function isIsoDate(value: string): boolean { const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value; }
