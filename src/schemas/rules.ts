import { invalidResponse } from "../errors.js";
import { parseManagedDescription } from "../rule-marker.js";
import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  normalizePagination,
  type FireflyCollection,
  type Pagination,
} from "./common.js";

export const RULE_TRIGGER_TYPES = [
  "from_account_starts",
  "from_account_ends",
  "from_account_is",
  "from_account_contains",
  "to_account_starts",
  "to_account_ends",
  "to_account_is",
  "to_account_contains",
  "amount_less",
  "amount_exactly",
  "amount_more",
  "description_starts",
  "description_ends",
  "description_contains",
  "description_is",
  "transaction_type",
  "category_is",
  "budget_is",
  "tag_is",
  "currency_is",
  "has_attachments",
  "has_no_category",
  "has_any_category",
  "has_no_budget",
  "has_any_budget",
  "has_no_tag",
  "has_any_tag",
  "notes_contains",
  "notes_starts",
  "notes_end",
  "notes_are",
  "no_notes",
  "any_notes",
  "source_account_is",
  "destination_account_is",
  "source_account_starts",
] as const;

export type RuleTriggerType = (typeof RULE_TRIGGER_TYPES)[number];
export type RuleMoment = "store-journal" | "update-journal" | "manual-activation";
export const ALLOWED_RULE_ACTION_TYPES = [
  "set_category",
  "set_budget",
  "add_tag",
  "remove_tag",
  "set_description",
  "set_notes",
  "set_source_account",
  "set_destination_account",
  "convert_transfer",
] as const;

export type AllowedRuleActionType = (typeof ALLOWED_RULE_ACTION_TYPES)[number];

export interface RuleTriggerInput {
  type: RuleTriggerType;
  value: string;
  prohibited?: boolean;
  active?: boolean;
  stopProcessing?: boolean;
}

export interface RuleActionInput {
  type: AllowedRuleActionType;
  value: string;
  active?: boolean;
  stopProcessing?: boolean;
}

export interface RawRuleTrigger {
  id?: string;
  type?: string;
  value?: string;
  prohibited?: boolean;
  order?: number;
  active?: boolean;
  stop_processing?: boolean;
  [key: string]: unknown;
}

export interface RawRuleAction {
  id?: string;
  type?: string;
  value?: string | null;
  order?: number;
  active?: boolean;
  stop_processing?: boolean;
  [key: string]: unknown;
}

export interface RuleAttributes {
  created_at?: string;
  updated_at?: string;
  title: string;
  description?: string | null;
  rule_group_id: string;
  rule_group_title?: string;
  order?: number;
  trigger: RuleMoment;
  active?: boolean;
  strict?: boolean;
  stop_processing?: boolean;
  triggers: RawRuleTrigger[];
  actions: RawRuleAction[];
  [key: string]: unknown;
}

export interface NormalizedRuleTrigger {
  type: string;
  value: string | null;
  prohibited: boolean;
  active: boolean;
  stopProcessing: boolean;
  order: number | null;
}

export interface NormalizedRuleAction {
  type: string;
  value: string | null;
  active: boolean;
  stopProcessing: boolean;
  order: number | null;
}

export interface NormalizedRule {
  id: string;
  title: string;
  description: string | null;
  ruleGroupId: string;
  ruleGroupTitle: string | null;
  trigger: string;
  order: number | null;
  active: boolean;
  strict: boolean;
  stopProcessing: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  triggers: NormalizedRuleTrigger[];
  actions: NormalizedRuleAction[];
  managed: boolean;
}

export interface RulePage {
  rules: NormalizedRule[];
  pagination: Pagination;
}

export interface CategorySummary {
  id: string;
  name: string;
  notes: string | null;
}

export interface CategoryPage {
  categories: CategorySummary[];
  pagination: Pagination;
}

export interface RuleGroupSummary {
  id: string;
  title: string;
  description: string | null;
  order: number | null;
  active: boolean;
}

export interface RuleGroupPage {
  ruleGroups: RuleGroupSummary[];
  pagination: Pagination;
}

export function normalizeRuleCollection(value: unknown): RulePage {
  const collection = parseCollection(value);
  return {
    rules: collection.data.map(normalizeRuleResource),
    pagination: normalizePagination(collection.meta.pagination, collection.data.length),
  };
}

export function normalizeRuleSingle(value: unknown): NormalizedRule {
  if (!isRecord(value) || !isRecord(value.data)) invalidResponse();
  return normalizeRuleResource(value.data);
}

export function normalizeCategoryCollection(value: unknown): CategoryPage {
  const collection = parseGenericCollection(value);
  const categories = collection.data.map((resource) => {
    if (!isRecord(resource) || typeof resource.id !== "string" || !isRecord(resource.attributes)) {
      invalidResponse();
    }
    const name = asString(resource.attributes.name);
    if (name === null) invalidResponse();
    return { id: resource.id, name, notes: asString(resource.attributes.notes) };
  });
  return {
    categories,
    pagination: normalizePagination(collection.meta.pagination, categories.length),
  };
}

export function normalizeRuleGroupCollection(value: unknown): RuleGroupPage {
  const collection = parseGenericCollection(value);
  const ruleGroups = collection.data.map((resource) => {
    if (!isRecord(resource) || typeof resource.id !== "string" || !isRecord(resource.attributes)) {
      invalidResponse();
    }
    const title = asString(resource.attributes.title);
    if (title === null) invalidResponse();
    return {
      id: resource.id,
      title,
      description: asString(resource.attributes.description),
      order: asNumber(resource.attributes.order),
      active: asBoolean(resource.attributes.active) ?? false,
    };
  });
  return {
    ruleGroups,
    pagination: normalizePagination(collection.meta.pagination, ruleGroups.length),
  };
}

function parseCollection(value: unknown): FireflyCollection<RuleAttributes> {
  return parseGenericCollection(value) as FireflyCollection<RuleAttributes>;
}

function parseGenericCollection(value: unknown): FireflyCollection<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) invalidResponse();
  return value as unknown as FireflyCollection<Record<string, unknown>>;
}

function normalizeRuleResource(value: unknown): NormalizedRule {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.attributes)) {
    invalidResponse();
  }
  const attributes = value.attributes;
  const title = asString(attributes.title);
  const ruleGroupId = asString(attributes.rule_group_id);
  const trigger = asString(attributes.trigger);
  if (title === null || ruleGroupId === null || trigger === null) invalidResponse();
  if (!Array.isArray(attributes.triggers) || !Array.isArray(attributes.actions)) invalidResponse();
  // Rule::description in Firefly v6.7.2 stores Laravel e() output. Decode exactly one
  // response layer so re-PUTs do not turn & into &amp;amp; and marker text is stable.
  const rawDescription = asString(attributes.description);
  const description = rawDescription === null ? null : decodeFireflyDescription(rawDescription);
  const managed = parseManagedDescription(description) !== null;
  const order = asNumber(attributes.order);
  const active = asBoolean(attributes.active) ?? false;
  const strict = asBoolean(attributes.strict) ?? true;
  const stopProcessing = asBoolean(attributes.stop_processing) ?? false;
  const triggers = attributes.triggers.map((item) => normalizeTrigger(item));
  const actions = attributes.actions.map((item) => normalizeAction(item));
  return {
    id: value.id, title, description, ruleGroupId,
    ruleGroupTitle: asString(attributes.rule_group_title), trigger, order, active, strict, stopProcessing,
    createdAt: asString(attributes.created_at), updatedAt: asString(attributes.updated_at), triggers, actions,
    managed,
  };
}

function normalizeTrigger(value: unknown): NormalizedRuleTrigger {
  if (!isRecord(value)) invalidResponse();
  const type = asString(value.type);
  if (type === null) invalidResponse();
  return {
    type,
    value: asString(value.value),
    prohibited: asBoolean(value.prohibited) ?? false,
    active: asBoolean(value.active) ?? true,
    stopProcessing: asBoolean(value.stop_processing) ?? false,
    order: asNumber(value.order),
  };
}

function normalizeAction(value: unknown): NormalizedRuleAction {
  if (!isRecord(value)) invalidResponse();
  const type = asString(value.type);
  if (type === null) invalidResponse();
  return { type, value: asString(value.value), active: asBoolean(value.active) ?? true, stopProcessing: asBoolean(value.stop_processing) ?? false, order: asNumber(value.order) };
}

// Kept local to avoid coupling response normalization to mutation policy internals.
function decodeFireflyDescription(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#0*39|#x0*27);/giu, (entity) => {
    const key = entity.toLowerCase();
    return key === "&amp;" ? "&" : key === "&lt;" ? "<" : key === "&gt;" ? ">" : key === "&quot;" ? "\"" : "'";
  });
}
