import { describe, expect, it } from "vitest";
import { FireflyError } from "../../src/errors.js";
import { FireflyService } from "../../src/service.js";
import type { TransactionUpdateInput } from "../../src/transaction-update.js";

const conversion = { transactionId: "123", type: "transfer", sourceAccountId: "10", destinationAccountId: "20" } as const;
function fixture() {
  return { data: { id: "123", attributes: { group_title: null, transactions: [{
    transaction_journal_id: "789", type: "withdrawal", source_id: "10", destination_id: "30",
    date: "2026-10-01T00:00:00+00:00", amount: "123.4500", currency_id: "1", currency_code: "USD",
    description: "Autopay", notes: "Original note", category_id: "4", budget_id: null,
    tags: ["imported"], external_id: "original-import-ref",
  }] } } };
}
class Client {
  state = fixture();
  calls: Array<{ method: string; path: string; body?: any; options?: unknown }> = [];
  afterWrite?: () => void;
  writeError?: Error;
  readError?: Error;
  accountType = "expense";
  accountActive = true;
  budgetActive = true;
  async get(path: string, options?: unknown) {
    this.calls.push({ method: "GET", path, options });
    if (path.startsWith("/budgets/")) return { data: { id: path.split("/").at(-1), attributes: { name: "Eating Out", active: this.budgetActive } } };
    if (path.startsWith("/categories/")) return { data: { id: path.split("/").at(-1), attributes: { name: "Food/Drink" } } };
    if (path.startsWith("/accounts/")) return { data: { id: path.split("/").at(-1), attributes: { type: this.accountType, active: this.accountActive } } };
    if (this.calls.some((call) => call.method === "PUT") && this.readError) throw this.readError;
    return structuredClone(this.state);
  }
  async put(path: string, body: any, options?: unknown) {
    this.calls.push({ method: "PUT", path, body, options });
    if (this.writeError) throw this.writeError;
    Object.assign(this.state.data.attributes.transactions[0]!, body.transactions[0]);
    this.afterWrite?.();
    return structuredClone(this.state);
  }
}
function setup() { const client = new Client(); return { client, service: new FireflyService(client as never) }; }

describe("targeted transaction updates", () => {
  it("assigns an existing budget to one withdrawal and returns it without altering other fields", async () => {
    const { client, service } = setup();
    const original = structuredClone(client.state.data.attributes.transactions[0]!);
    await expect(service.updateTransaction({ transactionId: "123", budgetId: "5" })).resolves.toMatchObject({
      changed: true, verified: true, transaction: { transactions: [{ budgetId: "5" }] },
    });
    expect(client.state.data.attributes.transactions[0]).toEqual({ ...original, budget_id: "5" });
    expect(client.calls.find(c => c.method === "PUT")?.body).toEqual({
      apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: "789", budget_id: "5" }],
    });
    await expect(service.updateTransaction({ transactionId: "123", budgetId: "5" })).resolves.toMatchObject({ changed: false });
    expect(client.calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });
  it.each(["deposit", "transfer", "conversion", "inactive", "split"])("rejects invalid budget assignments before writing: %s", async (kind) => {
    const { client, service } = setup();
    if (kind === "deposit" || kind === "transfer") client.state.data.attributes.transactions[0]!.type = kind;
    if (kind === "inactive") client.budgetActive = false;
    if (kind === "split") client.state.data.attributes.transactions.push(structuredClone(client.state.data.attributes.transactions[0]!));
    await expect(service.updateTransaction({ ...(kind === "conversion" ? conversion : { transactionId: "123" }), budgetId: "5" })).rejects.toBeInstanceOf(FireflyError);
    expect(client.calls.some(c => c.method === "PUT")).toBe(false);
  });
  it("reports an unpersisted budget as uncertain, without retrying", async () => {
    const { client, service } = setup();
    client.afterWrite = () => { client.state.data.attributes.transactions[0]!.budget_id = null; };
    await expect(service.updateTransaction({ transactionId: "123", budgetId: "5" })).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    expect(client.calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });
  it.each(["withdrawal", "deposit"])("sets category and %s counterparty without changing the bank side", async (type) => {
    const { client, service } = setup();
    client.state.data.attributes.transactions[0]!.type = type;
    client.accountType = type === "withdrawal" ? "expense" : "revenue";
    const original = structuredClone(client.state.data.attributes.transactions[0]!);
    await expect(service.updateTransaction({ transactionId: "123", categoryId: "14", counterpartyAccountId: "425", addTags: ["review"] })).resolves.toMatchObject({ verified: true });
    const changes = { category_id: "14", [type === "withdrawal" ? "destination_id" : "source_id"]: "425", tags: ["imported", "review"] };
    expect(client.state.data.attributes.transactions[0]).toEqual({ ...original, ...changes });
    expect(client.calls.find(c => c.method === "PUT")?.body).toEqual({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: "789", ...changes }] });
    await expect(service.updateTransaction({ transactionId: "123", categoryId: "14", counterpartyAccountId: "425" })).resolves.toMatchObject({ changed: false });
    expect(client.calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });
  it("supports category-only edits and verifies preservation failures", async () => {
    const { client, service } = setup();
    client.afterWrite = () => { client.state.data.attributes.transactions[0]!.category_id = "99"; };
    await expect(service.updateTransaction({ transactionId: "123", categoryId: "14" })).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    expect(client.calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });
  it.each(["wrongType", "inactive", "transfer", "split"])("rejects unsafe counterparty edits: %s", async (kind) => {
    const { client, service } = setup();
    if (kind === "wrongType") client.accountType = "asset";
    if (kind === "inactive") client.accountActive = false;
    if (kind === "transfer") client.state.data.attributes.transactions[0]!.type = "transfer";
    if (kind === "split") client.state.data.attributes.transactions.push(structuredClone(client.state.data.attributes.transactions[0]!));
    await expect(service.updateTransaction({ transactionId: "123", counterpartyAccountId: "425" })).rejects.toBeInstanceOf(FireflyError);
    expect(client.calls.some(c => c.method === "PUT")).toBe(false);
  });
  it("converts only the selected group/journal and preserves amount, dates and metadata", async () => {
    const { client, service } = setup();
    const original = structuredClone(client.state.data.attributes.transactions[0]!);
    const result = await service.updateTransaction(conversion);
    expect(result).toMatchObject({ changed: true, verified: true, transaction: { id: "123", transactions: [{ type: "transfer", destinationId: "20" }] } });
    expect(client.calls.map(({ method, path }) => [method, path])).toEqual([["GET", "/transactions/123"], ["PUT", "/transactions/123"], ["GET", "/transactions/123"]]);
    expect(client.calls[1]?.body).toEqual({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: "789", type: "transfer", source_id: "10", destination_id: "20" }] });
    expect(client.state.data.attributes.transactions[0]).toEqual({ ...original, type: "transfer", destination_id: "20" });
  });
  it("appends and deduplicates tags without sending conversion fields", async () => {
    const { client, service } = setup();
    await service.updateTransaction({ transactionId: "123", addTags: ["toDelete", "imported", "toDelete"] });
    expect(client.calls[1]?.body.transactions).toEqual([{ transaction_journal_id: "789", tags: ["imported", "toDelete"] }]);
    expect(client.state.data.attributes.transactions[0]?.type).toBe("withdrawal");
  });
  it("supports combined operations and avoids a second PUT when already satisfied", async () => {
    const { client, service } = setup();
    await service.updateTransaction({ ...conversion, addTags: ["review"] });
    await expect(service.updateTransaction({ ...conversion, addTags: ["review"] })).resolves.toMatchObject({ changed: false, verified: true });
    expect(client.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("accepts reordered tags on readback and skips already-present tags regardless of order", async () => {
    const { client, service } = setup();
    client.afterWrite = () => client.state.data.attributes.transactions[0]!.tags.reverse();
    await expect(service.updateTransaction({ transactionId: "123", addTags: ["review"] })).resolves.toMatchObject({ verified: true });
    await expect(service.updateTransaction({ transactionId: "123", addTags: ["imported", "review"] })).resolves.toMatchObject({ changed: false });
    expect(client.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("trims incoming tag names before merging, deduplicating and verifying", async () => {
    const { client, service } = setup();
    await expect(service.updateTransaction({ transactionId: "123", addTags: [" review ", "\treview\n", " imported "] })).resolves.toMatchObject({ changed: true, verified: true });
    expect(client.calls[1]?.body.transactions[0].tags).toEqual(["imported", "review"]);
    await expect(service.updateTransaction({ transactionId: "123", addTags: [" review "] })).resolves.toMatchObject({ changed: false, verified: true });
    expect(client.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it.each([
    { transactionId: "123", budgetId: "01" }, { transactionId: "123", budgetId: null },
    {}, { transactionId: "" }, { transactionId: "001", addTags: ["x"] },
    { transactionId: "123", categoryId: "01" }, { transactionId: "123", categoryId: null },
    { transactionId: "123", counterpartyAccountId: "../1" }, { ...conversion, counterpartyAccountId: "425" },
    { transactionId: "123" }, { transactionId: "123", type: "withdrawal" },
    { transactionId: "123", type: "transfer" }, { transactionId: "123", sourceAccountId: "10" },
    { ...conversion, sourceAccountId: "20" }, { ...conversion, destinationAccountId: "../2" },
    { transactionId: "123", addTags: [] }, { transactionId: "123", addTags: [" "] },
    { transactionId: "123", addTags: ["x".repeat(1025)] },
    { transactionId: "123", addTags: [1] }, { transactionId: "123", addTags: ["x"], dryRun: true },
  ])("rejects invalid arguments without requests: %j", async (input) => {
    const { client, service } = setup();
    await expect(service.updateTransaction(input as TransactionUpdateInput)).rejects.toMatchObject({ code: "FIREFLY_VALIDATION_FAILED" });
    expect(client.calls).toHaveLength(0);
  });
  it.each(["split", "budget", "missingJournal", "badTags", "wrongGroup", "special", "missingAmount"])("rejects unsafe input data before PUT: %s", async (kind) => {
    const { client, service } = setup(); const split = client.state.data.attributes.transactions[0]!;
    if (kind === "split") client.state.data.attributes.transactions.push(structuredClone(split));
    if (kind === "budget") Object.assign(split, { budget_id: "5" });
    if (kind === "missingJournal") split.transaction_journal_id = "";
    if (kind === "badTags") Object.assign(split, { tags: [1] });
    if (kind === "wrongGroup") client.state.data.id = "456";
    if (kind === "special") split.type = "opening balance";
    if (kind === "missingAmount") Object.assign(split, { amount: undefined });
    await expect(service.updateTransaction(conversion)).rejects.toBeInstanceOf(FireflyError);
    expect(client.calls.some((call) => call.method === "PUT")).toBe(false);
  });
  it.each(["destination_id", "amount", "tags", "transaction_journal_id"])("reports readback mismatch as uncertain: %s", async (field) => {
    const { client, service } = setup();
    client.afterWrite = () => Object.assign(client.state.data.attributes.transactions[0]!, { [field]: field === "tags" ? [] : "999" });
    await expect(service.updateTransaction(conversion)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    expect(client.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it.each(["FIREFLY_TIMEOUT", "FIREFLY_CANCELLED", "FIREFLY_TEMPORARY_FAILURE", "FIREFLY_NETWORK_ERROR"] as const)("never retries uncertain writes: %s", async (code) => {
    const { client, service } = setup(); client.writeError = new FireflyError(code, "test");
    await expect(service.updateTransaction(conversion)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
    expect(client.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
  });
  it("keeps a definite API rejection distinct from a failed post-write readback", async () => {
    const { client, service } = setup(); client.writeError = new FireflyError("FIREFLY_VALIDATION_FAILED", "test");
    await expect(service.updateTransaction(conversion)).rejects.toMatchObject({ code: "FIREFLY_VALIDATION_FAILED" });
    client.calls = []; client.writeError = undefined; client.readError = new FireflyError("FIREFLY_NOT_FOUND", "test");
    await expect(service.updateTransaction(conversion)).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
  });
  it("propagates cancellation to every request", async () => {
    const { client, service } = setup(); const signal = new AbortController().signal;
    await service.updateTransaction(conversion, signal);
    expect(client.calls.every((call) => (call.options as { signal: AbortSignal }).signal === signal)).toBe(true);
  });
});
