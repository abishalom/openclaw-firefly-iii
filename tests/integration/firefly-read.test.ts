import { createServer, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FireflyClient } from "../../src/client.js";
import { FireflyService } from "../../src/service.js";

let closeServer: () => Promise<void>;
let service: FireflyService;
const seenUrls: string[] = [];
const seenProxyHeaders: Array<string | undefined> = [];

beforeAll(async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://test");
    seenUrls.push(url.pathname + url.search);
    seenProxyHeaders.push(request.headers["x-proxy-auth"] as string | undefined);
    if (request.headers.authorization !== "Bearer dummy" || request.headers["x-proxy-auth"] !== "proxy-dummy") {
      response.statusCode = 403;
      response.end("denied");
      return;
    }
    switch (url.pathname) {
      case "/api/v1/transactions":
      case "/api/v1/search/transactions":
        return collection(response, [transactionResource("10")]);
      case "/api/v1/transactions/10":
        return json(response, { data: transactionResource("10") });
      case "/api/v1/categories":
        return collection(response, [resource("categories", "2", { name: "Groceries", notes: null })]);
      case "/api/v1/budgets":
        return collection(response, [resource("budgets", "5", { name: "Household", active: true, order: 1, notes: null })]);
      case "/api/v1/tags":
        return collection(response, [resource("tags", "6", { tag: "recurring", description: "Recurring payment" })]);
      case "/api/v1/accounts":
        return collection(response, [resource("accounts", "7", { name: "Checking", type: "asset", active: true })]);
      case "/api/v1/rules":
        return collection(response, [ruleResource("3")]);
      case "/api/v1/rules/3":
        return json(response, { data: ruleResource("3") });
      case "/api/v1/rule-groups":
        return collection(response, [resource("rule_groups", "4", { title: "Default", description: null, order: 1, active: true })]);
      default:
        response.statusCode = 404;
        response.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  service = new FireflyService(new FireflyClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "dummy",
    headers: { "X-Proxy-Auth": "proxy-dummy" },
    allowInsecureHttp: true,
  }));
});

afterAll(async () => closeServer());

describe("Phase 1 Firefly reads", () => {
  it("lists, gets, and searches normalized transactions with pagination", async () => {
    const listed = await service.listTransactions({ page: 2, limit: 10, start: "2026-09-01", end: "2026-09-30", type: "withdrawal" });
    expect(listed.transactions[0]?.transactions[0]).toMatchObject({
      description: "SUPER 99",
      amount: "25.00",
      categoryName: "Groceries",
    });
    expect(listed.pagination).toMatchObject({ total: 1, currentPage: 1 });
    await expect(service.getTransaction("10")).resolves.toMatchObject({ id: "10" });
    await expect(service.searchTransactions({ query: "description_contains:SUPER", page: 1, limit: 5 })).resolves.toMatchObject({
      transactions: [{ id: "10" }],
    });
    expect(seenUrls).toContain("/api/v1/transactions?page=2&limit=10&start=2026-09-01&end=2026-09-30&type=withdrawal");
    expect(seenUrls).toContain("/api/v1/search/transactions?query=description_contains%3ASUPER&page=1&limit=5");
  });

  it("lists reusable metadata and accounts", async () => {
    await expect(service.listCategories({ page: 1, limit: 20 })).resolves.toMatchObject({
      categories: [{ id: "2", name: "Groceries" }],
    });
    await expect(service.listBudgets({ page: 1, limit: 20 })).resolves.toMatchObject({
      budgets: [{ id: "5", name: "Household", active: true }],
    });
    await expect(service.listTags({ page: 1, limit: 20 })).resolves.toMatchObject({
      tags: [{ id: "6", name: "recurring" }],
    });
    await expect(service.listAccounts({ page: 1, limit: 20 })).resolves.toMatchObject({
      accounts: [{ id: "7", name: "Checking", type: "asset", active: true }],
    });
    expect(seenUrls).toContain("/api/v1/accounts?type=all&page=1&limit=20");
  });

  it("lists rules, gets a rule, and lists groups", async () => {
    await expect(service.listRules({ page: 1, limit: 20 })).resolves.toMatchObject({
      rules: [{ id: "3", active: false, managed: false }],
    });
    await expect(service.getRule("3")).resolves.toMatchObject({ id: "3", title: "User rule" });
    await expect(service.listRuleGroups({ page: 1, limit: 20 })).resolves.toMatchObject({
      ruleGroups: [{ id: "4", title: "Default", active: true }],
    });
    expect(seenProxyHeaders.every((header) => header === "proxy-dummy")).toBe(true);
  });
});

function transactionResource(id: string) {
  return resource("transactions", id, {
    group_title: null,
    transactions: [{
      transaction_journal_id: "101",
      type: "withdrawal",
      date: "2026-09-17T00:00:00+00:00",
      amount: "25.00",
      currency_code: "USD",
      currency_symbol: "$",
      description: "SUPER 99",
      source_id: "1",
      source_name: "Checking",
      destination_id: "9",
      destination_name: "Super 99",
      category_id: "2",
      category_name: "Groceries",
      notes: null,
      tags: [],
    }],
  });
}

function ruleResource(id: string) {
  return resource("rules", id, {
    title: "User rule",
    description: "Ordinary Firefly rule",
    rule_group_id: "4",
    rule_group_title: "Default",
    trigger: "store-journal",
    active: false,
    strict: true,
    stop_processing: false,
    triggers: [{ type: "description_contains", value: "SUPER", prohibited: false, active: true }],
    actions: [{ type: "set_category", value: "Groceries", active: true }],
  });
}

function resource(type: string, id: string, attributes: Record<string, unknown>) {
  return { type, id, attributes, links: {} };
}

function collection(response: ServerResponse, data: unknown[]): void {
  json(response, {
    data,
    meta: { pagination: { total: data.length, count: data.length, per_page: 50, current_page: 1, total_pages: 1 } },
    links: {},
  });
}

function json(response: ServerResponse, body: unknown): void {
  response.setHeader("Content-Type", "application/vnd.api+json");
  response.end(JSON.stringify(body));
}
