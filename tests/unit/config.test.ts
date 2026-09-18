import { describe, expect, it } from "vitest";
import { buildApiBaseUrl, fireflyConfigSchema, normalizeConfig } from "../../src/config.js";
import { FireflyError } from "../../src/errors.js";
import { Value } from "typebox/value";

describe("Firefly config", () => {
  it.each([
    ["https://firefly.example", "https://firefly.example/api/v1/"],
    ["https://firefly.example/", "https://firefly.example/api/v1/"],
    ["https://firefly.example/api", "https://firefly.example/api/v1/"],
    ["https://firefly.example/api/v1", "https://firefly.example/api/v1/"],
    ["https://firefly.example/money", "https://firefly.example/money/api/v1/"],
  ])("normalizes %s", (input, expected) => {
    expect(buildApiBaseUrl(input).toString()).toBe(expected);
  });

  it("requires HTTPS by default and rejects URL credentials", () => {
    expect(() => buildApiBaseUrl("http://firefly.test")).toThrow(FireflyError);
    expect(() => buildApiBaseUrl("https://user:pass@firefly.test")).toThrow(FireflyError);
    expect(buildApiBaseUrl("http://127.0.0.1:8080", true).protocol).toBe("http:");
  });

  it("defaults and bounds maxResponseBytes", () => {
    expect(normalizeConfig({ baseUrl: "https://firefly.test", accessToken: "token" }).maxResponseBytes).toBe(
      5 * 1024 * 1024,
    );
    expect(() =>
      normalizeConfig({
        baseUrl: "https://firefly.test",
        accessToken: "token",
        maxResponseBytes: 10 * 1024 * 1024 + 1,
      }),
    ).toThrow(/maxResponseBytes/u);
  });

  it("keeps best-effort pending deletion disabled unless explicitly enabled", () => {
    expect(normalizeConfig({ baseUrl: "https://firefly.test", accessToken: "token" }).allowBestEffortPendingRuleDeletion).toBe(false);
    expect(normalizeConfig({ baseUrl: "https://firefly.test", accessToken: "token", allowBestEffortPendingRuleDeletion: true }).allowBestEffortPendingRuleDeletion).toBe(true);
  });

  it("rejects unresolved secret-shaped runtime values without exposing them", () => {
    const ref = { source: "store", provider: "default", id: "FIREFLY_SECRET" };
    try {
      normalizeConfig({ baseUrl: "https://firefly.test", accessToken: ref as unknown as string });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(FireflyError);
      expect(String(error)).not.toContain("FIREFLY_SECRET");
    }
  });

  it("accepts SecretRefs in source config for declared secret inputs", () => {
    const ref = { source: "store", provider: "default", id: "FIREFLY_ACCESS_TOKEN" };
    expect(Value.Check(fireflyConfigSchema, { baseUrl: "https://firefly.test", accessToken: ref })).toBe(true);
    expect(
      Value.Check(fireflyConfigSchema, {
        baseUrl: "https://firefly.test",
        accessToken: ref,
        headers: { "X-Access-Token": ref },
      }),
    ).toBe(true);
  });
});
