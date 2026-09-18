import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FireflyClient } from "../../src/client.js";
import { FireflyError } from "../../src/errors.js";
import { FireflyService } from "../../src/service.js";

interface RuleState {
  id: string;
  title: string;
  description: string;
  rule_group_id: string;
  rule_group_title: string;
  trigger: string;
  order: number;
  active: boolean;
  strict: boolean;
  stop_processing: boolean;
  triggers: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
}

let closeServer: (() => Promise<void>) | undefined;
let client: FireflyClient;
let service: FireflyService;
let rules: Map<string, RuleState>;
let nextId: number;
let confirmPayload: Record<string, unknown> | undefined;
let corruptActivation: boolean;
let failResignPut: boolean;
let requests: Array<{ method: string; path: string; search: string }>;

beforeEach(async () => {
  rules = new Map();
  nextId = 100;
  confirmPayload = undefined;
  corruptActivation = false;
  failResignPut = false;
  requests = [];
  const server = createServer(async (request, response) => {
    await route(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  // Lifecycle deletion deliberately opts in: Firefly has no conditional DELETE,
  // so production must have no external rule writers when this is enabled.
  client = new FireflyClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "integration-token",
    headers: { "X-Proxy-Token": "required-proxy-token" },
    allowInsecureHttp: true,
  });
  service = new FireflyService(client, true);
});

afterEach(async () => {
  await closeServer?.();
});

describe("pending rule lifecycle", () => {
  it("creates inactive, tests, updates while inactive, retests, and confirms exact contents", async () => {
    const created = await service.createPendingRule({
      title: "Categorize Super 99",
      description: "Created by an integration test",
      ruleGroupId: "7",
      triggers: [{ type: "description_contains", value: "SUPER 99" }],
      actions: [
        { type: "set_category", value: "Groceries" },
        { type: "set_destination_account", value: "Super 99" },
      ],
    });
    expect(created.active).toBe(false);
    expect(created.pending).toBe(true);
    expect(rules.get(created.id)?.active).toBe(false);
    expect(rules.get(created.id)?.description).toMatch(/^\[openclaw-firefly:pending:v1;/u);
    expect(rules.get(created.id)?.actions.map((action) => action.type)).toEqual([
      "set_category",
      "set_destination_account",
    ]);
    expect(requests.some((request) => request.path === "/api/v1/accounts")).toBe(true);

    const firstTest = await service.testRule({ id: created.id, maxResults: 50 });
    expect(firstTest.transactions).toHaveLength(2);
    expect(firstTest).toMatchObject({
      ruleId: created.id,
      strict: true,
      queries: ['description_contains:"SUPER 99"'],
      previewEngine: "firefly-search",
      truncated: false,
    });

    const updated = await service.updatePendingRule({
      id: created.id,
      description: "Narrowed after review",
      triggers: [{ type: "description_is", value: "SUPER 99" }],
    });
    expect(updated.active).toBe(false);
    expect(updated.description).toContain("Narrowed after review");
    expect(rules.get(created.id)?.active).toBe(false);

    const secondTest = await service.testRule({ id: created.id, start: "2026-01-01", end: "2026-12-31" });
    expect(secondTest.transactions).toHaveLength(1);
    expect(secondTest.queries).toEqual([
      'description_is:"SUPER 99" date_after:"2026-01-01" date_before:"2026-12-31"',
    ]);
    expect(requests.some((request) => request.path.endsWith("/test"))).toBe(false);

    const beforeConfirm = structuredClone(rules.get(created.id));
    const confirmed = await service.confirmPendingRule(created.id, updated.proposalDigest!);
    expect(confirmed.active).toBe(true);
    expect(confirmed.pending).toBe(false);
    expect(confirmPayload && Object.keys(confirmPayload).sort()).toEqual(["active", "description"]);
    expect(rules.get(created.id)?.triggers).toEqual(beforeConfirm?.triggers);
    expect(rules.get(created.id)?.actions).toEqual(beforeConfirm?.actions);
  });

  it("re-signs v6.7.2 canonical response semantics without double-escaping", async () => {
    const created = await service.createPendingRule({
      title: "  Escaped title  ", description: "A & <B> \"quote\" 'apostrophe'",
      ruleGroupId: "7", order: 2048,
      triggers: [{ type: "has_attachments", value: "ignored by Firefly" }],
      actions: [{ type: "set_category", value: "Groceries" }],
    });
    expect(created.title).toBe("Escaped title");
    expect(created.order).toBe(1);
    expect(created.triggers[0]?.value).toBe("true");
    expect(created.description).toContain("A & <B> \"quote\" 'apostrophe'");
    expect(created.proposalDigest).toBeTruthy();
    const confirmed = await service.confirmPendingRule(created.id, created.proposalDigest!);
    expect(confirmed.description).toContain("A & <B> \"quote\" 'apostrophe'");
    expect(confirmed.description).not.toContain("&amp;");
  });

  it("unions non-strict preview searches in rule order and honors stop-processing", async () => {
    rules.set("900", {
      id: "900",
      title: "Non-strict preview",
      description: "Ordinary Firefly rule",
      rule_group_id: "7",
      rule_group_title: "Default",
      trigger: "store-journal",
      order: 1,
      active: false,
      strict: false,
      stop_processing: false,
      triggers: [
        { type: "description_is", value: "SUPER 99", active: true, stop_processing: false, order: 1 },
        { type: "description_contains", value: "SUPER 99", active: true, stop_processing: false, order: 2 },
      ],
      actions: [{ type: "set_category", value: "Groceries", active: true }],
    });
    const union = await service.testRule({ id: "900" });
    expect(union).toMatchObject({ strict: false, executedQueries: 2, truncated: false });
    expect(union.transactions.map((transaction) => transaction.id)).toEqual(["501", "502"]);

    rules.get("900")!.triggers[0]!.stop_processing = true;
    const stopped = await service.testRule({ id: "900" });
    expect(stopped).toMatchObject({ strict: false, executedQueries: 1, truncated: false });
    expect(stopped.transactions.map((transaction) => transaction.id)).toEqual(["501"]);
  });

  it("rolls a semantically mismatched activation back to the reviewed inactive proposal", async () => {
    const pending = await service.createPendingRule({
      title: "Rollback activation",
      ruleGroupId: "7",
      triggers: [{ type: "description_contains", value: "SAFE" }],
      actions: [{ type: "set_category", value: "Groceries" }],
    });
    corruptActivation = true;
    await expect(
      service.confirmPendingRule(pending.id, pending.proposalDigest!),
    ).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });

    const stored = await service.getRule(pending.id);
    expect(stored.active).toBe(false);
    expect(stored.pending).toBe(true);
    expect(stored.triggers[0]?.value).toBe("SAFE");
    expect(stored.proposalDigest).toBe(pending.proposalDigest);
  });

  it("does not delete a failed creation when best-effort deletion is disabled", async () => {
    const safeService = new FireflyService(client);
    failResignPut = true;
    await expect(
      safeService.createPendingRule({
        title: "Failed resign",
        ruleGroupId: "7",
        order: 2048,
        triggers: [{ type: "has_attachments", value: "canonicalized" }],
        actions: [{ type: "set_category", value: "Groceries" }],
      }),
    ).rejects.toMatchObject({ code: "FIREFLY_TEMPORARY_FAILURE" });
    expect([...rules.values()]).toHaveLength(1);
    expect([...rules.values()][0]?.active).toBe(false);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("rejects and deletes only an OpenClaw-owned inactive pending rule", async () => {
    const pending = await service.createPendingRule({
      title: "Reject me",
      ruleGroupId: "7",
      triggers: [{ type: "description_contains", value: "MARKET" }],
      actions: [{ type: "set_category", value: "Groceries" }],
    });
    await expect(service.rejectPendingRule(pending.id)).resolves.toEqual({ id: pending.id, rejected: true });
    expect(rules.has(pending.id)).toBe(false);

    rules.set("999", {
      id: "999",
      title: "User rule",
      description: "Created in Firefly",
      rule_group_id: "7",
      rule_group_title: "Default",
      trigger: "store-journal",
      active: false,
      strict: true,
      stop_processing: false,
      triggers: [{ type: "description_contains", value: "USER", active: true }],
      actions: [{ type: "set_category", value: "Groceries", active: true }],
    });
    const requestCount = requests.length;
    await expect(service.rejectPendingRule("999")).rejects.toMatchObject({ code: "FIREFLY_RULE_NOT_PENDING" });
    await expect(service.updatePendingRule({ id: "999", title: "Attack" })).rejects.toMatchObject({
      code: "FIREFLY_RULE_NOT_PENDING",
    });
    await expect(service.confirmPendingRule("999", "0".repeat(64))).rejects.toMatchObject({
      code: "FIREFLY_RULE_NOT_PENDING",
    });
    expect(rules.get("999")?.title).toBe("User rule");
    expect(requests.slice(requestCount).every((request) => request.method === "GET")).toBe(true);
  });

  it("serializes update versus stale confirmation and refuses externally changed contents", async () => {
    const pending = await service.createPendingRule({ title: "Concurrent", ruleGroupId: "7", triggers: [{ type: "description_contains", value: "A" }], actions: [{ type: "set_category", value: "Groceries" }] });
    const originalDigest = pending.proposalDigest!;
    const [updated, confirmation] = await Promise.allSettled([
      service.updatePendingRule({ id: pending.id, title: "Changed" }),
      service.confirmPendingRule(pending.id, originalDigest),
    ]);
    expect(updated.status).toBe("fulfilled");
    expect(confirmation).toMatchObject({ status: "rejected", reason: { code: "FIREFLY_RULE_NOT_PENDING" } });
    const state = rules.get(pending.id)!;
    state.title = "External change";
    rules.set(pending.id, state);
    await expect(service.rejectPendingRule(pending.id)).rejects.toMatchObject({ code: "FIREFLY_RULE_NOT_PENDING" });
  });

  it("rejects zero and leading-zero IDs before requests or lock selection", async () => {
    const before = requests.length;
    await expect(service.getRule("0")).rejects.toMatchObject({ code: "FIREFLY_VALIDATION_FAILED" });
    await expect(service.testRule({ id: "001" })).rejects.toMatchObject({ code: "FIREFLY_VALIDATION_FAILED" });
    await expect(service.updatePendingRule({ id: "0100", title: "nope" })).rejects.toMatchObject({ code: "FIREFLY_VALIDATION_FAILED" });
    await expect(Promise.allSettled([service.confirmPendingRule("000", "0".repeat(64)), service.rejectPendingRule("00")])).resolves.toHaveLength(2);
    expect(requests).toHaveLength(before);
  });

  it("rejects a forbidden action before making a Firefly request", async () => {
    const before = requests.length;
    await expect(
      service.createPendingRule({
        title: "Unsafe",
        ruleGroupId: "7",
        triggers: [{ type: "description_contains", value: "X" }],
        actions: [{ type: "delete_transaction", value: "x" } as never],
      }),
    ).rejects.toBeInstanceOf(FireflyError);
    expect(requests).toHaveLength(before);
  });

  it("accepts a destination-only proposal and rejects a missing destination account", async () => {
    const created = await service.createPendingRule({
      title: "Route to Super 99",
      ruleGroupId: "7",
      triggers: [{ type: "description_is", value: "SUPER 99" }],
      actions: [{ type: "set_destination_account", value: "Super 99" }],
    });
    expect(created.actions).toMatchObject([
      { type: "set_destination_account", value: "Super 99" },
    ]);

    const postCount = requests.filter((request) => request.method === "POST").length;
    await expect(service.createPendingRule({
      title: "Missing destination",
      ruleGroupId: "7",
      triggers: [{ type: "description_is", value: "MISSING" }],
      actions: [{ type: "set_destination_account", value: "Does Not Exist" }],
    })).rejects.toMatchObject({ code: "FIREFLY_RULE_UNSAFE" });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(postCount);
  });

  it("accepts the curated metadata, text, account, and transfer actions", async () => {
    const created = await service.createPendingRule({
      title: "Normalize credit card autopay",
      ruleGroupId: "7",
      triggers: [{ type: "description_contains", value: "AUTOPAY" }],
      actions: [
        { type: "set_category", value: "Groceries" },
        { type: "set_budget", value: "Household" },
        { type: "add_tag", value: "recurring" },
        { type: "remove_tag", value: "imported" },
        { type: "set_description", value: "Credit card autopay" },
        { type: "set_notes", value: "Normalized by an approved rule" },
        { type: "convert_transfer", value: "Credit Card" },
        { type: "set_source_account", value: "Checking" },
        { type: "set_destination_account", value: "Credit Card" },
      ],
    });
    expect(created.actions.map((action) => action.type)).toEqual([
      "set_category",
      "set_budget",
      "add_tag",
      "remove_tag",
      "set_description",
      "set_notes",
      "convert_transfer",
      "set_source_account",
      "set_destination_account",
    ]);
  });
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://test");
  requests.push({ method: request.method ?? "GET", path: url.pathname, search: url.search });
  if (request.headers.authorization !== "Bearer integration-token" || request.headers["x-proxy-token"] !== "required-proxy-token") {
    return json(response, 403, { message: "denied" });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/categories") {
    return collection(response, [resource("categories", "1", { name: "Groceries", notes: null })]);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/accounts") {
    return collection(response, [
      resource("accounts", "2", { name: "Super 99", type: "expense", active: true }),
      resource("accounts", "3", { name: "Checking", type: "asset", active: true }),
      resource("accounts", "4", { name: "Credit Card", type: "debt", active: true }),
    ]);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/budgets") {
    return collection(response, [resource("budgets", "5", { name: "Household", active: true, order: 1, notes: null })]);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/tags") {
    return collection(response, [
      resource("tags", "6", { tag: "recurring", description: null }),
      resource("tags", "7", { tag: "imported", description: null }),
    ]);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/search/transactions") {
    const query = url.searchParams.get("query") ?? "";
    const candidates = [
      transaction("501", "SUPER 99", "121.15"),
      transaction("502", "SUPER 99 EXPRESS", "38.54"),
    ];
    if (query.includes('description_is:"SUPER 99"')) {
      return collection(response, candidates.filter((item) => item.attributes.transactions[0]?.description === "SUPER 99"));
    }
    if (query.includes('description_contains:"SUPER 99"')) return collection(response, candidates);
    return collection(response, []);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/rules") {
    const body = await readBody(request);
    const id = String(nextId++);
    const state = stateFromBody(id, body);
    rules.set(id, state);
    return json(response, 200, singleRule(state));
  }

  const match = /^\/api\/v1\/rules\/(\d+)$/u.exec(url.pathname);
  if (match?.[1]) {
    const id = match[1];
    const state = rules.get(id);
    if (!state) return json(response, 404, { message: "missing" });
    if (request.method === "GET") {
      return json(response, 200, singleRule(state));
    }
    if (request.method === "PUT") {
      const body = await readBody(request);
      if (
        failResignPut &&
        body.active === false &&
        Object.keys(body).sort().join(",") === "active,description"
      ) {
        failResignPut = false;
        return json(response, 500, { message: "simulated re-sign failure" });
      }
      if (body.active === true) confirmPayload = body;
      const updated = stateFromBody(id, body, state);
      if (body.active === true && corruptActivation) {
        corruptActivation = false;
        const firstTrigger = updated.triggers[0];
        if (firstTrigger) firstTrigger.value = "UNREVIEWED";
      }
      rules.set(id, updated);
      return json(response, 200, singleRule(updated));
    }
    if (request.method === "DELETE") {
      rules.delete(id);
      response.statusCode = 204;
      response.end();
      return;
    }
  }
  return json(response, 404, { message: "unknown" });
}

function stateFromBody(id: string, body: Record<string, unknown>, previous?: RuleState): RuleState {
  const triggers = Array.isArray(body.triggers) ? body.triggers.map((trigger) => {
    const copy = { ...(trigger as Record<string, unknown>) };
    if (["has_attachments", "has_no_category", "has_any_category", "has_no_budget", "has_any_budget", "has_no_tag", "has_any_tag", "no_notes", "any_notes"].includes(String(copy.type))) copy.value = "true";
    return copy;
  }) : previous?.triggers ?? [];
  return {
    id,
    title: (body.title === undefined ? previous?.title ?? "" : String(body.title)).trim(),
    description: body.description === undefined ? previous?.description ?? "" : escapeFirefly(String(body.description)),
    rule_group_id: String(Number(body.rule_group_id === undefined ? previous?.rule_group_id ?? "7" : body.rule_group_id)),

    rule_group_title: previous?.rule_group_title ?? "Default",
    trigger: body.trigger === undefined ? previous?.trigger ?? "store-journal" : String(body.trigger),
    order: body.order === undefined ? previous?.order ?? 1 : Math.min(Number(body.order), 1),
    active: body.active === undefined ? previous?.active ?? false : body.active === true,
    strict: body.strict === undefined ? previous?.strict ?? true : body.strict !== false,
    stop_processing: body.stop_processing === undefined ? previous?.stop_processing ?? false : body.stop_processing === true,
    triggers,
    actions: Array.isArray(body.actions) ? body.actions as Array<Record<string, unknown>> : previous?.actions ?? [],
  };
}

function escapeFirefly(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#039;");
}

function singleRule(state: RuleState) {
  return { data: resource("rules", state.id, state) };
}

function resource(type: string, id: string, attributes: Record<string, unknown>) {
  return { type, id, attributes, links: { self: `http://test/${type}/${id}` } };
}

function transaction(id: string, description: string, amount: string) {
  return resource("transactions", id, {
    group_title: null,
    transactions: [{
      transaction_journal_id: `${id}1`,
      type: "withdrawal",
      date: "2026-09-01T00:00:00+00:00",
      amount,
      currency_code: "USD",
      currency_symbol: "$",
      description,
      source_id: "1",
      source_name: "Checking",
      destination_id: "2",
      destination_name: "Super 99",
      category_id: "1",
      category_name: "Groceries",
      notes: null,
      tags: [],
    }],
  });
}

function collection(response: ServerResponse, data: unknown[]): void {
  json(response, 200, {
    data,
    meta: { pagination: { total: data.length, count: data.length, per_page: 50, current_page: 1, total_pages: 1 } },
    links: {},
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", status >= 400 ? "application/json" : "application/vnd.api+json");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
