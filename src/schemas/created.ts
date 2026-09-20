import { invalidResponse } from "../errors.js";
import { asBoolean, asString, isRecord } from "./common.js";

export interface CreatedExpenseAccount { id: string; name: string; type: "expense"; notes: string | null; active: boolean; }
export interface CreatedCategory { id: string; name: string; notes: string | null; }
export interface CreatedTag { id: string; name: string; description: string | null; }

function resource(value: unknown): { id: string; attributes: Record<string, unknown> } {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.id !== "string" || !isRecord(value.data.attributes)) invalidResponse();
  return { id: value.data.id, attributes: value.data.attributes };
}

export function normalizeCreatedExpenseAccount(value: unknown): CreatedExpenseAccount {
  const { id, attributes } = resource(value);
  const name = asString(attributes.name);
  if (name === null || attributes.type !== "expense") invalidResponse();
  return { id, name, type: "expense", notes: asString(attributes.notes), active: asBoolean(attributes.active) ?? true };
}

export function normalizeCreatedCategory(value: unknown): CreatedCategory {
  const { id, attributes } = resource(value);
  const name = asString(attributes.name);
  if (name === null) invalidResponse();
  return { id, name, notes: asString(attributes.notes) };
}

export function normalizeCreatedTag(value: unknown): CreatedTag {
  const { id, attributes } = resource(value);
  // TagStore calls its name field "tag"; this is intentionally not "name".
  const name = asString(attributes.tag);
  if (name === null) invalidResponse();
  return { id, name, description: asString(attributes.description) };
}
