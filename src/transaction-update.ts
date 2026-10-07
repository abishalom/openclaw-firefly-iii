import type { FireflyClient } from "./client.js";
import { FireflyError, invalidResponse } from "./errors.js";
import { isRecord } from "./schemas/common.js";
import { normalizeTransactionSingle } from "./schemas/transactions.js";

export interface TransactionUpdateInput {
  transactionId: string;
  type?: "transfer";
  sourceAccountId?: string;
  destinationAccountId?: string;
  addTags?: string[];
}

function reject(message: string): never {
  throw new FireflyError("FIREFLY_VALIDATION_FAILED", message);
}

function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) reject("IDs must be canonical positive numeric strings.");
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag) => right.includes(tag));
}

function parse(value: unknown, expectedId: string) {
  const group = normalizeTransactionSingle(value);
  if (group.id !== expectedId || !isRecord(value) || !isRecord(value.data) || !isRecord(value.data.attributes)) invalidResponse();
  if (group.transactions.length !== 1) reject("Only single-entry transaction groups are supported; splits are not modified.");
  const entries = value.data.attributes.transactions;
  if (!Array.isArray(entries) || !isRecord(entries[0])) invalidResponse();
  const split = entries[0];
  for (const key of ["type", "date", "amount", "currency_id", "currency_code", "description", "source_id", "destination_id"]) {
    if (typeof split[key] !== "string") invalidResponse("Transaction is missing fields needed for verified updates.");
  }
  if (typeof split.transaction_journal_id !== "string" || !/^[1-9][0-9]*$/u.test(split.transaction_journal_id)) invalidResponse();
  if (!Array.isArray(split.tags) || !split.tags.every((tag) => typeof tag === "string")) invalidResponse("Cannot safely preserve transaction tags.");
  return { group, split, tags: split.tags as string[] };
}

/** Narrow PUT: never resubmit an entire GET response or omit another split. */
export async function updateTransaction(client: FireflyClient, input: TransactionUpdateInput, signal?: AbortSignal) {
  const allowed = new Set(["transactionId", "type", "sourceAccountId", "destinationAccountId", "addTags"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) reject("Unsupported transaction update argument.");
  id(input.transactionId);
  const conversion = input.type !== undefined || input.sourceAccountId !== undefined || input.destinationAccountId !== undefined;
  if (conversion) {
    if (input.type !== "transfer") reject("Conversion requires type=transfer and both account IDs.");
    id(input.sourceAccountId);
    id(input.destinationAccountId);
    if (input.sourceAccountId === input.destinationAccountId) reject("Transfer accounts must be different.");
  }
  if (input.addTags !== undefined && (
    !Array.isArray(input.addTags) || input.addTags.length === 0 || input.addTags.length > 100 ||
    input.addTags.some((tag) => typeof tag !== "string" || tag.trim() === "" || tag.length > 1024)
  )) reject("addTags must contain 1–100 nonblank tags of at most 1024 characters.");
  if (!conversion && input.addTags === undefined) reject("Supply a conversion or addTags.");
  const path = `/transactions/${input.transactionId}`;
  const options = signal === undefined ? {} : { signal };
  const before = parse(await client.get<unknown>(path, options), input.transactionId);
  if (conversion && !["withdrawal", "deposit", "transfer"].includes(String(before.split.type))) reject("Only withdrawals, deposits, or transfers can be converted.");
  // Firefly removes budgets on transfers, even when the budget is omitted from PUT.
  if ((conversion || before.split.type === "transfer") && before.split.budget_id != null) reject("Updating this transaction as a transfer would remove its budget; unsupported.");
  const tags = [...new Set([...before.tags, ...(input.addTags ?? []).map((tag) => tag.trim())])];
  const changes: Record<string, unknown> = {};
  if (conversion) Object.assign(changes, { type: "transfer", source_id: input.sourceAccountId, destination_id: input.destinationAccountId });
  const changed = Object.entries(changes).some(([key, value]) => before.split[key] !== value) || !sameTags(before.tags, tags);
  if (!changed) return { changed: false, verified: true, transaction: before.group };
  try {
    await client.put(path, {
      apply_rules: false,
      fire_webhooks: false,
      transactions: [{
        transaction_journal_id: before.split.transaction_journal_id,
        ...changes,
        ...(input.addTags === undefined ? {} : { tags }),
      }],
    }, options);
  } catch (error) {
    if (error instanceof FireflyError && ["FIREFLY_AUTH_FAILED", "FIREFLY_PROXY_DENIED", "FIREFLY_NOT_FOUND", "FIREFLY_VALIDATION_FAILED", "FIREFLY_RATE_LIMITED"].includes(error.code)) throw error;
    throw uncertain(error);
  }
  try {
    const after = parse(await client.get<unknown>(path, options), input.transactionId);
    const expected = { ...before.split, ...changes };
    const checkedFields = [
      "transaction_journal_id", "type", "source_id", "destination_id", "date", "amount",
      "currency_id", "currency_code", "foreign_amount", "foreign_currency_id", "description",
      "notes", "category_id", "budget_id", "bill_id", "reconciled", "internal_reference", "external_id",
    ];
    if (checkedFields.some((key) => expected[key] !== after.split[key]) ||
      before.group.groupTitle !== after.group.groupTitle || !sameTags(tags, after.tags)) {
      invalidResponse("Transaction readback did not match the expected update.");
    }
    return { changed: true, verified: true, transaction: after.group };
  } catch (error) {
    throw uncertain(error);
  }
}

function uncertain(cause: unknown) {
  return new FireflyError("FIREFLY_MUTATION_UNCERTAIN", "Transaction update may have succeeded but could not be verified. Inspect the transaction before retrying; no automatic retry was made.", undefined, { cause });
}
