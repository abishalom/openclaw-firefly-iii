import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FireflyClient } from "../../src/client.js";
import { FireflyError } from "../../src/errors.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string }> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  closers.push(() => new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve()))));
  return { url: `http://127.0.0.1:${address.port}` };
}

describe("FireflyClient", () => {
  it("joins /api/v1, constructs bearer auth, and sends custom headers", async () => {
    let captured: IncomingMessage | undefined;
    const endpoint = await server((request, response) => {
      captured = request;
      response.setHeader("Content-Type", "application/json");
      response.end('{"data":"ok"}');
    });
    const client = new FireflyClient({
      baseUrl: endpoint.url,
      accessToken: "dummy-token",
      headers: { "CF-Access-Client-Id": "client-id", "X-Environment": "test" },
      allowInsecureHttp: true,
    });
    await expect(client.get("/transactions", { query: { page: 2, "accounts[]": [1, 2] } })).resolves.toEqual({ data: "ok" });
    expect(captured?.url).toBe("/api/v1/transactions?page=2&accounts%5B%5D=1&accounts%5B%5D=2");
    expect(captured?.headers.authorization).toBe("Bearer dummy-token");
    expect(captured?.headers["cf-access-client-id"]).toBe("client-id");
    expect(captured?.headers["x-environment"]).toBe("test");
    expect(captured?.headers.accept).toContain("application/vnd.api+json");
  });

  it("uses configured headers on every request", async () => {
    const seen: Array<string | undefined> = [];
    const endpoint = await server((request, response) => {
      seen.push(request.headers["x-security-token"] as string | undefined);
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    });
    const client = new FireflyClient({
      baseUrl: endpoint.url,
      accessToken: "token",
      headers: { "X-Security-Token": "proxy-secret" },
      allowInsecureHttp: true,
    });
    await client.get("/transactions");
    await client.get("/categories");
    expect(seen).toEqual(["proxy-secret", "proxy-secret"]);
  });

  it("normalizes failures without exposing response bodies or secrets", async () => {
    const logs: string[] = [];
    const endpoint = await server((_request, response) => {
      response.statusCode = 403;
      response.end("gateway-debug-secret and test-token");
    });
    const client = new FireflyClient(
      {
        baseUrl: endpoint.url,
        accessToken: "test-token",
        headers: { "X-Secret": "header-secret" },
        allowInsecureHttp: true,
      },
      { debug: (message) => logs.push(message) },
    );
    await expect(client.get("/rules")).rejects.toMatchObject({
      code: "FIREFLY_PROXY_DENIED",
      status: 403,
    });
    const visible = logs.join(" ");
    expect(visible).not.toContain("test-token");
    expect(visible).not.toContain("header-secret");
    expect(visible).not.toContain("gateway-debug-secret");
  });

  it("times out and rejects invalid JSON", async () => {
    const slow = await server((_request, response) => {
      setTimeout(() => response.end("{}"), 250);
    });
    const timeoutClient = new FireflyClient({
      baseUrl: slow.url,
      accessToken: "token",
      allowInsecureHttp: true,
      requestTimeoutMs: 100,
    });
    await expect(timeoutClient.get("/rules")).rejects.toMatchObject({ code: "FIREFLY_TIMEOUT" });

    const invalid = await server((_request, response) => response.end("not-json"));
    const invalidClient = new FireflyClient({
      baseUrl: invalid.url,
      accessToken: "token",
      allowInsecureHttp: true,
    });
    await expect(invalidClient.get("/rules")).rejects.toMatchObject({
      code: "FIREFLY_INVALID_RESPONSE",
    });
  });

  it("keeps the timeout active after headers while a response body stalls", async () => {
    let bodyClosed = false;
    const stalled = await server((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.flushHeaders();
      response.write('{"data":');
      response.once("close", () => {
        bodyClosed = true;
      });
    });
    const client = new FireflyClient({
      baseUrl: stalled.url,
      accessToken: "token",
      allowInsecureHttp: true,
      requestTimeoutMs: 150,
    });

    await expect(client.get("/rules")).rejects.toMatchObject({ code: "FIREFLY_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bodyClosed).toBe(true);
  });

  it("cancels streamed bodies that exceed maxResponseBytes before parsing", async () => {
    let bodyClosed = false;
    const oversized = await server((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.once("close", () => {
        bodyClosed = true;
      });
      response.write('{"data":"');
      response.write("x".repeat(2048));
    });
    const client = new FireflyClient({
      baseUrl: oversized.url,
      accessToken: "token",
      allowInsecureHttp: true,
      maxResponseBytes: 1024,
    });

    await expect(client.get("/rules")).rejects.toMatchObject({ code: "FIREFLY_INVALID_RESPONSE" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bodyClosed).toBe(true);
  });

  it("never includes the token in a thrown error", async () => {
    const endpoint = await server((_request, response) => {
      response.statusCode = 401;
      response.end("bad secret-token-value");
    });
    const client = new FireflyClient({
      baseUrl: endpoint.url,
      accessToken: "secret-token-value",
      allowInsecureHttp: true,
    });
    try {
      await client.get("/rules");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(FireflyError);
      expect(JSON.stringify(error)).not.toContain("secret-token-value");
      expect(String(error)).not.toContain("secret-token-value");
    }
  });
});
