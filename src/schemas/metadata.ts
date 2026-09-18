import { invalidResponse } from "../errors.js";
import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  normalizePagination,
  type FireflyCollection,
  type Pagination,
} from "./common.js";

export interface BudgetSummary {
  id: string;
  name: string;
  active: boolean;
  order: number | null;
  notes: string | null;
}

export interface BudgetPage {
  budgets: BudgetSummary[];
  pagination: Pagination;
}

export interface TagSummary {
  id: string;
  name: string;
  description: string | null;
}

export interface TagPage {
  tags: TagSummary[];
  pagination: Pagination;
}

export function normalizeBudgetCollection(value: unknown): BudgetPage {
  const collection = parseCollection(value);
  const budgets = collection.data.map((resource) => {
    if (!isRecord(resource) || typeof resource.id !== "string" || !isRecord(resource.attributes)) invalidResponse();
    const name = asString(resource.attributes.name);
    if (name === null) invalidResponse();
    return {
      id: resource.id,
      name,
      active: asBoolean(resource.attributes.active) ?? true,
      order: asNumber(resource.attributes.order),
      notes: asString(resource.attributes.notes),
    };
  });
  return { budgets, pagination: normalizePagination(collection.meta.pagination, budgets.length) };
}

export function normalizeTagCollection(value: unknown): TagPage {
  const collection = parseCollection(value);
  const tags = collection.data.map((resource) => {
    if (!isRecord(resource) || typeof resource.id !== "string" || !isRecord(resource.attributes)) invalidResponse();
    const name = asString(resource.attributes.tag);
    if (name === null) invalidResponse();
    return { id: resource.id, name, description: asString(resource.attributes.description) };
  });
  return { tags, pagination: normalizePagination(collection.meta.pagination, tags.length) };
}

function parseCollection(value: unknown): FireflyCollection<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) invalidResponse();
  return value as unknown as FireflyCollection<Record<string, unknown>>;
}
