import { createHash, randomUUID } from "node:crypto";
import { FireflyError } from "./errors.js";
import {
  ALLOWED_RULE_ACTION_TYPES,
  RULE_TRIGGER_TYPES,
  type NormalizedRule,
  type RuleActionInput,
  type RuleTriggerInput,
} from "./schemas/rules.js";

const PENDING_MARKER =
  /^\[openclaw-firefly:pending:v1;proposal=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12});digest=([0-9a-f]{64});created=([^;\]]+);expires=([^\]]+)\](?:\n|$)/u;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1_000;

export interface PendingMarker { proposalId: string; proposalDigest: string; createdAt: string; expiresAt: string; userDescription: string; }

export function proposalDigest(rule: Pick<NormalizedRule, "title" | "ruleGroupId" | "order" | "trigger" | "strict" | "stopProcessing" | "triggers" | "actions">, userDescription: string): string {
  // Explicit property order makes this stable across runtimes; arrays retain Firefly execution order.
  const semantic = {
    title: rule.title, ruleGroupId: rule.ruleGroupId, order: rule.order,
    trigger: rule.trigger, strict: rule.strict, stopProcessing: rule.stopProcessing,
    triggers: rule.triggers.map(({ type, value, prohibited, active, stopProcessing, order }) => ({ type, value, prohibited, active, stopProcessing, order })),
    actions: rule.actions.map(({ type, value, active, stopProcessing, order }) => ({ type, value, active, stopProcessing, order })),
    userDescription,
  };
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

export function createPendingDescription(userDescription: string | undefined, digest: string, now = new Date(), proposalId = randomUUID()): string {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MS).toISOString();
  return pendingDescription({ proposalId, proposalDigest: digest, createdAt, expiresAt, userDescription: "" }, userDescription?.trim() ?? "");
}

export function parsePendingDescription(description: string | null): PendingMarker | null {
  if (description === null) return null;
  const match = PENDING_MARKER.exec(description);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !isIsoDate(match[3]) || !isIsoDate(match[4])) return null;
  return { proposalId: match[1], proposalDigest: match[2], createdAt: match[3], expiresAt: match[4], userDescription: description.slice(match[0].length) };
}

export function updatePendingDescription(marker: PendingMarker, digest: string, userDescription?: string): string {
  return pendingDescription({ ...marker, proposalDigest: digest }, userDescription === undefined ? marker.userDescription : userDescription.trim());
}
function pendingDescription(marker: PendingMarker, suffix: string): string {
  const prefix = `[openclaw-firefly:pending:v1;proposal=${marker.proposalId};digest=${marker.proposalDigest};created=${marker.createdAt};expires=${marker.expiresAt}]`;
  const description = suffix === "" ? prefix : `${prefix}\n${suffix}`;
  if (description.length > 32_768) throw new FireflyError("FIREFLY_RULE_UNSAFE", "Rule description is too long.");
  return description;
}
export function createConfirmedDescription(marker: PendingMarker, now = new Date()): string {
  const prefix = `[openclaw-firefly:confirmed:v1;proposal=${marker.proposalId};digest=${marker.proposalDigest};confirmed=${now.toISOString()}]`;
  return marker.userDescription === "" ? prefix : `${prefix}\n${marker.userDescription}`;
}
export function assertPendingRule(rule: NormalizedRule): PendingMarker {
  const marker = parsePendingDescription(rule.description);
  if (marker === null || rule.active || marker.proposalDigest !== proposalDigest(rule, marker.userDescription)) {
    throw new FireflyError("FIREFLY_RULE_NOT_PENDING", "The rule is not an intact inactive OpenClaw-owned pending proposal.");
  }
  return marker;
}
export function assertAllowedActions(actions: readonly RuleActionInput[] | NormalizedRule["actions"]): void {
  if (actions.length < 1 || actions.length > 20) throw new FireflyError("FIREFLY_RULE_UNSAFE", "A pending rule must contain 1 to 20 allowed actions.");
  const allowed = new Set<string>(ALLOWED_RULE_ACTION_TYPES);
  const repeatable = new Set(["add_tag", "remove_tag"]);
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const addedTags = new Set<string>();
  const removedTags = new Set<string>();
  for (const action of actions) {
    if (!allowed.has(action.type)) {
      throw new FireflyError("FIREFLY_RULE_UNSAFE", `Rule action ${JSON.stringify(action.type)} is not allowed.`);
    }
    const maxLength = action.type === "set_description" || action.type === "set_notes" ? 32_000 : 1024;
    if (typeof action.value !== "string" || action.value.trim() === "" || action.value.length > maxLength || ("active" in action && action.active !== true)) {
      throw new FireflyError("FIREFLY_RULE_UNSAFE", `${action.type} requires an active non-empty value no longer than ${maxLength} characters.`);
    }
    const key = `${action.type}\u0000${action.value}`;
    if (seen.has(key)) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Duplicate ${action.type} action values are not allowed.`);
    seen.add(key);
    counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
    if (action.type === "add_tag") addedTags.add(action.value);
    if (action.type === "remove_tag") removedTags.add(action.value);
  }
  for (const [type, count] of counts) {
    if (count > 1 && !repeatable.has(type)) {
      throw new FireflyError("FIREFLY_RULE_UNSAFE", `A pending rule may contain at most one ${type} action.`);
    }
  }
  for (const tag of addedTags) {
    if (removedTags.has(tag)) throw new FireflyError("FIREFLY_RULE_UNSAFE", `A pending rule cannot both add and remove tag ${JSON.stringify(tag)}.`);
  }
}
export function assertAllowedTriggers(triggers: readonly RuleTriggerInput[] | NormalizedRule["triggers"]): void {
  if (triggers.length === 0) throw new FireflyError("FIREFLY_RULE_UNSAFE", "A pending rule must contain a trigger.");
  const allowed = new Set<string>(RULE_TRIGGER_TYPES);
  for (const trigger of triggers) {
    if (!allowed.has(trigger.type) || typeof trigger.value !== "string" || trigger.value.trim() === "" || trigger.value.length > 1024 || ("active" in trigger && trigger.active !== true)) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Rule trigger ${JSON.stringify(trigger.type)} is not supported by the verified API contract.`);
  }
}
function isIsoDate(value: string): boolean { const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value; }
