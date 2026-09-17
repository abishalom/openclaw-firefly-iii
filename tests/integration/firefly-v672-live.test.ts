import { afterEach, describe, expect, it } from "vitest";
import { FireflyClient } from "../../src/client.js";
import { FireflyError } from "../../src/errors.js";
import { FireflyService } from "../../src/service.js";

// Deliberately opt-in: point these only at a disposable Firefly III v6.7.2 instance.
const baseUrl = process.env.FIREFLY_LIVE_BASE_URL;
const accessToken = process.env.FIREFLY_LIVE_ACCESS_TOKEN;
const category = process.env.FIREFLY_LIVE_CATEGORY;
const ruleGroupId = process.env.FIREFLY_LIVE_RULE_GROUP_ID;
const enabled = process.env.FIREFLY_LIVE_ALLOW_DESTRUCTIVE === "1"
  && Boolean(baseUrl && accessToken && category && ruleGroupId);
const createdIds: string[] = [];
const live = describe.skipIf(!enabled);

live("Firefly III v6.7.2 live lifecycle", () => {
  const client = new FireflyClient({ baseUrl: baseUrl ?? "https://invalid.example", accessToken: accessToken ?? "disabled", allowInsecureHttp: baseUrl?.startsWith("http://") ?? false });
  const service = new FireflyService(client, true);
  afterEach(async () => {
    // Direct teardown avoids testing rejection as cleanup and must not silently leak active rules.
    const ids = createdIds.splice(0);
    const results = await Promise.allSettled(ids.map((id) => client.delete(`/rules/${id}`)));
    const leaked = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      if (result.reason instanceof FireflyError && result.reason.code === "FIREFLY_NOT_FOUND") return [];
      return [ids[index] ?? "unknown"];
    });
    if (leaked.length > 0) {
      throw new Error(`Failed to clean live Firefly test rule(s): ${leaked.join(", ")}`);
    }
  });

  it("requires exactly v6.7.2 and exercises create/test/update/confirm plus rejection", async () => {
    const about = await client.get<{ data?: { version?: string } }>("/about");
    expect(about.data?.version).toBe("6.7.2");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pending = await service.createPendingRule({ title: `OpenClaw live ${suffix}`, description: `live & <${suffix}>`, ruleGroupId: ruleGroupId!, triggers: [{ type: "description_contains", value: `OPENCLAW-${suffix}` }], actions: [{ type: "set_category", value: category! }] });
    createdIds.push(pending.id);
    await service.testRule({ id: pending.id, maxResults: 1 });
    const updated = await service.updatePendingRule({ id: pending.id, description: `updated & <${suffix}>` });
    const confirmed = await service.confirmPendingRule(updated.id, updated.proposalDigest!);
    expect(confirmed.active).toBe(true);

    const rejected = await service.createPendingRule({ title: `OpenClaw reject ${suffix}`, ruleGroupId: ruleGroupId!, triggers: [{ type: "description_contains", value: `REJECT-${suffix}` }], actions: [{ type: "set_category", value: category! }] });
    createdIds.push(rejected.id);
    await expect(service.rejectPendingRule(rejected.id)).resolves.toEqual({ id: rejected.id, rejected: true });
    createdIds.splice(createdIds.indexOf(rejected.id), 1);
  });
});
