import { FireflyError } from "./errors.js";
import {
  formatManagedDescription as formatManagedDescriptionValue,
  parseManagedDescription,
  type ManagedDescription,
} from "./rule-marker.js";
import {
  ALLOWED_RULE_ACTION_TYPES,
  RULE_TRIGGER_TYPES,
  type NormalizedRule,
  type RuleActionInput,
  type RuleTriggerInput,
} from "./schemas/rules.js";

export { parseManagedDescription, type ManagedDescription };

export function formatManagedDescription(userDescription?: string): string {
  const description = formatManagedDescriptionValue(userDescription);
  if (description.length > 32_768) throw new FireflyError("FIREFLY_RULE_UNSAFE", "Rule description is too long.");
  return description;
}

export function isManaged(rule: Pick<NormalizedRule, "description">): boolean {
  return parseManagedDescription(rule.description) !== null;
}

export function assertManaged(rule: Pick<NormalizedRule, "id" | "description">): ManagedDescription {
  const marker = parseManagedDescription(rule.description);
  if (marker === null) {
    throw new FireflyError("FIREFLY_RULE_UNSAFE", `Rule ${rule.id} is not managed by OpenClaw.`);
  }
  return marker;
}

export function assertInactive(rule: Pick<NormalizedRule, "id" | "active">): void {
  if (rule.active) {
    throw new FireflyError("FIREFLY_RULE_UNSAFE", `Rule ${rule.id} must be inactive.`);
  }
}

export function assertAllowedActions(actions: readonly RuleActionInput[] | NormalizedRule["actions"]): void {
  if (actions.length < 1 || actions.length > 20) throw new FireflyError("FIREFLY_RULE_UNSAFE", "A managed rule must contain 1 to 20 allowed actions.");
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
    if (typeof action.value !== "string" || action.value.trim() === "" || action.value.length > maxLength) {
      throw new FireflyError("FIREFLY_RULE_UNSAFE", `${action.type} requires a non-empty value no longer than ${maxLength} characters.`);
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
      throw new FireflyError("FIREFLY_RULE_UNSAFE", `A managed rule may contain at most one ${type} action.`);
    }
  }
  for (const tag of addedTags) {
    if (removedTags.has(tag)) throw new FireflyError("FIREFLY_RULE_UNSAFE", `A managed rule cannot both add and remove tag ${JSON.stringify(tag)}.`);
  }
}

export function assertAllowedTriggers(triggers: readonly RuleTriggerInput[] | NormalizedRule["triggers"]): void {
  if (triggers.length === 0) throw new FireflyError("FIREFLY_RULE_UNSAFE", "A managed rule must contain a trigger.");
  const allowed = new Set<string>(RULE_TRIGGER_TYPES);
  for (const trigger of triggers) {
    if (!allowed.has(trigger.type) || typeof trigger.value !== "string" || trigger.value.trim() === "" || trigger.value.length > 1024) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Rule trigger ${JSON.stringify(trigger.type)} is not supported by the verified API contract.`);
  }
}
