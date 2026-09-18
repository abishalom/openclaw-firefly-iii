import { invalidResponse } from "../errors.js";
import { asBoolean, asString, isRecord, normalizePagination, type FireflyCollection, type Pagination } from "./common.js";

export interface AccountSummary {
  id: string;
  name: string;
  type: string | null;
  active: boolean;
}

export interface AccountPage {
  accounts: AccountSummary[];
  pagination: Pagination;
}

export function normalizeAccountCollection(value: unknown): AccountPage {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) invalidResponse();
  const collection = value as unknown as FireflyCollection<Record<string, unknown>>;
  const accounts = collection.data.map((resource) => {
    if (!isRecord(resource) || typeof resource.id !== "string" || !isRecord(resource.attributes)) invalidResponse();
    const name = asString(resource.attributes.name);
    if (name === null) invalidResponse();
    return {
      id: resource.id,
      name,
      type: asString(resource.attributes.type),
      active: asBoolean(resource.attributes.active) ?? true,
    };
  });
  return {
    accounts,
    pagination: normalizePagination(collection.meta.pagination, accounts.length),
  };
}
