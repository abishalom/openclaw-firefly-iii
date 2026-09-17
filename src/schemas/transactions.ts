import { invalidResponse } from "../errors.js";
import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  normalizePagination,
  type FireflyCollection,
  type FireflySingle,
  type Pagination,
} from "./common.js";

export interface TransactionSplitAttributes {
  transaction_journal_id?: string;
  type?: string;
  date?: string;
  amount?: string;
  currency_id?: string;
  currency_code?: string;
  currency_symbol?: string;
  description?: string;
  source_id?: string | null;
  source_name?: string | null;
  destination_id?: string | null;
  destination_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  [key: string]: unknown;
}

export interface TransactionAttributes {
  created_at?: string;
  updated_at?: string;
  group_title?: string | null;
  transactions: TransactionSplitAttributes[];
  [key: string]: unknown;
}

export interface NormalizedTransactionSplit {
  journalId: string | null;
  type: string | null;
  date: string | null;
  description: string | null;
  amount: string | null;
  currencyCode: string | null;
  currencySymbol: string | null;
  sourceId: string | null;
  sourceName: string | null;
  destinationId: string | null;
  destinationName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  notes: string | null;
  tags: string[];
}

export interface NormalizedTransactionGroup {
  id: string;
  groupTitle: string | null;
  transactions: NormalizedTransactionSplit[];
}

export interface TransactionPage {
  transactions: NormalizedTransactionGroup[];
  pagination: Pagination;
}

export function normalizeTransactionCollection(value: unknown, maxItems?: number): TransactionPage {
  const collection = parseCollection(value);
  const resources = maxItems === undefined ? collection.data : collection.data.slice(0, maxItems);
  const transactions = resources.map((resource) => normalizeTransactionResource(resource));
  return {
    transactions,
    pagination: normalizePagination(collection.meta.pagination, collection.data.length),
  };
}

export function normalizeTransactionSingle(value: unknown): NormalizedTransactionGroup {
  if (!isRecord(value) || !isRecord(value.data)) invalidResponse();
  return normalizeTransactionResource(value.data);
}

function parseCollection(value: unknown): FireflyCollection<TransactionAttributes> {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) invalidResponse();
  return value as unknown as FireflyCollection<TransactionAttributes>;
}

function normalizeTransactionResource(value: unknown): NormalizedTransactionGroup {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.attributes)) {
    invalidResponse();
  }
  const attributes = value.attributes;
  if (!Array.isArray(attributes.transactions)) invalidResponse();
  return {
    id: value.id,
    groupTitle: asString(attributes.group_title),
    transactions: attributes.transactions.map((split) => normalizeSplit(split)),
  };
}

function normalizeSplit(value: unknown): NormalizedTransactionSplit {
  if (!isRecord(value)) invalidResponse();
  const rawTags = value.tags;
  return {
    journalId: asString(value.transaction_journal_id),
    type: asString(value.type),
    date: asString(value.date),
    description: asString(value.description),
    amount: asString(value.amount),
    currencyCode: asString(value.currency_code),
    currencySymbol: asString(value.currency_symbol),
    sourceId: asString(value.source_id),
    sourceName: asString(value.source_name),
    destinationId: asString(value.destination_id),
    destinationName: asString(value.destination_name),
    categoryId: asString(value.category_id),
    categoryName: asString(value.category_name),
    notes: asString(value.notes),
    tags: Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

// Keep imports/types anchored to the verified JSON:API envelope names.
void (null as FireflySingle<TransactionAttributes> | null);
void asBoolean;
void asNumber;
