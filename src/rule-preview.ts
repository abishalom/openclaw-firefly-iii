import { FireflyError } from "./errors.js";
import { RULE_TRIGGER_TYPES, type NormalizedRule, type NormalizedRuleTrigger } from "./schemas/rules.js";

const ALLOWED_TRIGGER_TYPES = new Set<string>(RULE_TRIGGER_TYPES);

const ROOT_OPERATORS: Readonly<Record<string, string>> = {
  from_account_starts: "source_account_starts",
  from_account_ends: "source_account_ends",
  from_account_is: "source_account_is",
  from_account_contains: "source_account_contains",
  to_account_starts: "destination_account_starts",
  to_account_ends: "destination_account_ends",
  to_account_is: "destination_account_is",
  to_account_contains: "destination_account_contains",
  amount_exactly: "amount_is",
  notes_end: "notes_ends",
  notes_are: "notes_is",
};

const CONTEXT_FREE_OPERATORS = new Set([
  "has_attachments",
  "has_no_category",
  "has_any_category",
  "has_no_budget",
  "has_any_budget",
  "has_no_tag",
  "has_any_tag",
  "no_notes",
  "any_notes",
]);

export interface RulePreviewFilters {
  start?: string;
  end?: string;
  accountIds?: string[];
}

export interface CompiledRulePreview {
  strict: boolean;
  queries: string[];
  triggerStopProcessing: boolean[];
}

/**
 * Mirrors Firefly III v6.7.2 RuleRepository::getSearchQuery for the trigger
 * subset this plugin permits. Strict rules become one AND query. Non-strict
 * rules become one query per trigger so the service can union the results in
 * rule order, matching SearchRuleEngine's OR behavior.
 */
export function compileRulePreview(rule: NormalizedRule, filters: RulePreviewFilters = {}): CompiledRulePreview {
  const triggers = rule.triggers.filter((trigger) => trigger.active && trigger.type !== "user_action");
  if (triggers.length === 0) {
    throw new FireflyError("FIREFLY_RULE_UNSAFE", "The persisted rule has no active previewable triggers.");
  }

  const filterClauses = compileFilterClauses(filters);
  if (rule.strict) {
    return {
      strict: true,
      queries: [[...triggers.map(compileTrigger), ...filterClauses].join(" ")],
      triggerStopProcessing: [false],
    };
  }

  return {
    strict: false,
    queries: triggers.map((trigger) => [compileTrigger(trigger), ...filterClauses].join(" ")),
    triggerStopProcessing: triggers.map((trigger) => trigger.stopProcessing),
  };
}

function compileTrigger(trigger: NormalizedRuleTrigger): string {
  if (!ALLOWED_TRIGGER_TYPES.has(trigger.type)) {
    throw new FireflyError(
      "FIREFLY_RULE_UNSAFE",
      `The persisted rule uses unsupported preview trigger ${JSON.stringify(trigger.type)}.`,
    );
  }
  const operator = ROOT_OPERATORS[trigger.type] ?? trigger.type;
  if (!isSafeOperator(operator)) {
    throw new FireflyError(
      "FIREFLY_RULE_UNSAFE",
      `The persisted rule uses unsupported preview trigger ${JSON.stringify(trigger.type)}.`,
    );
  }
  const field = `${trigger.prohibited ? "-" : ""}${operator}`;
  if (CONTEXT_FREE_OPERATORS.has(operator)) return `${field}:true`;
  if (trigger.value === null || trigger.value.length === 0) {
    throw new FireflyError(
      "FIREFLY_INVALID_RESPONSE",
      `The persisted rule trigger ${JSON.stringify(trigger.type)} has no value.`,
    );
  }
  return `${field}:"${escapeSearchValue(trigger.value)}"`;
}

function compileFilterClauses(filters: RulePreviewFilters): string[] {
  const clauses: string[] = [];
  if (filters.start !== undefined) clauses.push(`date_after:"${escapeSearchValue(filters.start)}"`);
  if (filters.end !== undefined) clauses.push(`date_before:"${escapeSearchValue(filters.end)}"`);
  if (filters.accountIds !== undefined && filters.accountIds.length > 0) {
    clauses.push(`account_id:"${filters.accountIds.join(",")}"`);
  }
  return clauses;
}

function escapeSearchValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function isSafeOperator(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/u.test(value);
}
