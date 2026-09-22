import { describe, expect, it } from "vitest";
import { FireflyClient } from "../../src/client.js";
import { FireflyService } from "../../src/service.js";

// Deliberately opt-in and read-only: this must never mutate production rules.
const baseUrl = process.env.FIREFLY_LIVE_BASE_URL;
const accessToken = process.env.FIREFLY_LIVE_ACCESS_TOKEN;
const enabled = process.env.FIREFLY_LIVE_READ_ONLY === "1" && Boolean(baseUrl && accessToken);
const live = describe.skipIf(!enabled);

live("Firefly III v6.7.2 live reads", () => {
  const client = new FireflyClient({
    baseUrl: baseUrl ?? "https://invalid.example",
    accessToken: accessToken ?? "disabled",
    allowInsecureHttp: baseUrl?.startsWith("http://") ?? false,
  });
  const service = new FireflyService(client);

  it("verifies the supported backend and reads normalized rules without mutating them", async () => {
    const about = await client.get<{ data?: { version?: string } }>("/about");
    expect(about.data?.version).toBe("6.7.2");
    await expect(service.listRules({ page: 1, limit: 1 })).resolves.toMatchObject({ rules: expect.any(Array) });
  });
});
