import { describe, expect, it } from "vitest";
import { FireflyService, type CreateRuleInput } from "../../src/service.js";

function fixture(accountTypes = ["expense", "revenue"]) {
  let state: Record<string, unknown> = {};
  const writes: unknown[] = [];
  const pages: number[] = [];
  const resource = () => ({ data: { type: "rules", id: "1", attributes: state } });
  const client = {
    get: async (path: string, options?: { query?: { page?: number } }) => {
      if (path === "/accounts") {
        const page = options?.query?.page ?? 1; pages.push(page);
        return { data: [{ id: String(page), attributes: { name: "IRS", type: accountTypes[page - 1], active: true } }], meta: { pagination: { current_page: page, total_pages: accountTypes.length } } };
      }
      return resource();
    },
    post: async (_path: string, body: Record<string, unknown>) => { writes.push(body); state = body; return resource(); },
    put: async (_path: string, body: Record<string, unknown>) => { writes.push(body); state = { ...state, ...body }; return resource(); },
  };
  return { service: new FireflyService(client as never), writes, pages };
}
function input(overrides: Partial<CreateRuleInput> = {}): CreateRuleInput {
  return { title: "IRS", ruleGroupId: "1", strict: true, triggers: [{ type: "transaction_type", value: "withdrawal" }], actions: [{ type: "set_destination_account", value: "IRS" }], ...overrides };
}

describe("typed account target validation", () => {
  it("reuses an expense name shared with revenue through create, update and activation, across pages", async () => {
    const m = fixture();
    await m.service.createRule(input());
    await m.service.updateRule({ id: "1", title: "Tax" });
    await m.service.activateRule("1", true);
    expect(m.pages).toEqual([1, 2, 1, 2, 1, 2]);
    expect(m.writes).toHaveLength(3);
  });
  it("resolves a deposit source to revenue", async () => {
    const m = fixture();
    await expect(m.service.createRule(input({ triggers: [{ type: "transaction_type", value: "deposit" }], actions: [{ type: "set_source_account", value: "IRS" }] }))).resolves.toMatchObject({ id: "1" });
  });
  it.each([
    { strict: false },
    { triggers: [{ type: "transaction_type", value: "withdrawal", prohibited: true }] },
    { triggers: [{ type: "transaction_type", value: "withdrawal", active: false }] },
    { triggers: [{ type: "description_contains", value: "IRS", stopProcessing: true }, { type: "transaction_type", value: "withdrawal" }] },
    { triggers: [{ type: "transaction_type", value: "withdrawal" }, { type: "transaction_type", value: "deposit" }] },
    { actions: [{ type: "convert_transfer", value: "IRS" }, { type: "set_destination_account", value: "IRS" }] },
  ] as Partial<CreateRuleInput>[]) ("keeps uncertain rule contexts ambiguous: %j", async (override) => {
    const m = fixture();
    await expect(m.service.createRule(input(override))).rejects.toMatchObject({ code: "FIREFLY_RULE_UNSAFE" });
    expect(m.writes).toEqual([]);
  });
  it.each([["expense", "expense"], ["expense", "liabilities"], ["revenue"]])("rejects incompatible or ambiguous compatible targets: %j", async (...types) => {
    const m = fixture(types);
    await expect(m.service.createRule(input())).rejects.toMatchObject({ code: "FIREFLY_RULE_UNSAFE" });
    expect(m.writes).toEqual([]);
  });
  it("rechecks changed type guards even when actions are not updated", async () => {
    const m = fixture(); await m.service.createRule(input());
    await expect(m.service.updateRule({ id: "1", strict: false })).rejects.toMatchObject({ code: "FIREFLY_RULE_UNSAFE" });
    expect(m.writes).toHaveLength(1);
  });
});
