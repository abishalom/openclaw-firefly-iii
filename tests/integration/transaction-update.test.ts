import { createServer } from "node:http";
import { expect, it } from "vitest";
import { FireflyClient } from "../../src/client.js";
import { FireflyService } from "../../src/service.js";

it("performs targeted GET/PUT/GET over HTTP and preserves the unrelated group", async () => {
  const resources: Record<string, any> = Object.fromEntries(["123", "456"].map((id) => [id, {
    data: { id, attributes: { group_title: null, transactions: [{
      transaction_journal_id: String(Number(id) + 1000), type: "withdrawal", source_id: "10", destination_id: "30",
      date: "2026-10-01T00:00:00+00:00", amount: "125.00", currency_id: "1", currency_code: "USD",
      description: "Card autopay", notes: "Import evidence", tags: ["imported"], budget_id: null,
    }] } },
  }]));
  const untouched = structuredClone(resources["456"]);
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const found = /^\/api\/v1\/transactions\/(123|456)$/u.exec(req.url ?? "");
    if (!found || req.headers.authorization !== "Bearer test-token") { res.writeHead(403).end(); return; }
    const resource = resources[found[1]!]!;
    if (req.method === "PUT") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); bodies.push(body);
      Object.assign(resource.data.attributes.transactions[0], body.transactions[0]);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(resource));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const service = new FireflyService(new FireflyClient({ baseUrl: `http://127.0.0.1:${address.port}`, accessToken: "test-token", allowInsecureHttp: true }));
    await expect(service.updateTransaction({ transactionId: "123", type: "transfer", sourceAccountId: "10", destinationAccountId: "20", addTags: ["review"] })).resolves.toMatchObject({ changed: true, verified: true });
    expect(requests).toEqual(["GET /api/v1/transactions/123", "PUT /api/v1/transactions/123", "GET /api/v1/transactions/123"]);
    expect(bodies).toEqual([{ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: "1123", type: "transfer", source_id: "10", destination_id: "20", tags: ["imported", "review"] }] }]);
    expect(resources["456"]).toEqual(untouched);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
