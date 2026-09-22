import { describe, expect, it } from "vitest";
import { FireflyError } from "../../src/errors.js";
import { FireflyService } from "../../src/service.js";

class Client {
  calls: Array<{ path: string; body: unknown }> = [];
  async post(path: string, body: unknown): Promise<unknown> {
    this.calls.push({ path, body });
    if (path === "/accounts") return single("accounts", "1", { name: "Vendor", type: "expense", notes: "n", active: true });
    if (path === "/categories") return single("categories", "2", { name: "Food", notes: "n" });
    return single("tags", "3", { tag: "receipt", description: "d" });
  }
}
function single(type: string, id: string, attributes: Record<string, unknown>) { return { data: { type, id, attributes } }; }

describe("direct metadata creation", () => {
  it("uses the exact narrow upstream payload fields", async () => {
    const client = new Client(); const service = new FireflyService(client as never);
    await expect(service.createExpenseAccount({ name: "Vendor", notes: "n" })).resolves.toMatchObject({ type: "expense", name: "Vendor" });
    await expect(service.createCategory({ name: "Food", notes: "n" })).resolves.toMatchObject({ name: "Food" });
    await expect(service.createTag({ name: "receipt", description: "d" })).resolves.toMatchObject({ name: "receipt" });
    expect(client.calls).toEqual([
      { path: "/accounts", body: { name: "Vendor", type: "expense", notes: "n" } },
      { path: "/categories", body: { name: "Food", notes: "n" } },
      { path: "/tags", body: { tag: "receipt", description: "d" } },
    ]);
  });

  it("reports an ambiguous creation response as uncertain", async () => {
    const client = { post: async () => { throw new FireflyError("FIREFLY_TEMPORARY_FAILURE", "simulated"); } };
    const service = new FireflyService(client as never);
    await expect(service.createCategory({ name: "Food" })).rejects.toMatchObject({ code: "FIREFLY_MUTATION_UNCERTAIN" });
  });

  it("rejects blank and oversized fields before a request", async () => {
    const client = new Client(); const service = new FireflyService(client as never);
    await expect(service.createCategory({ name: " " })).rejects.toBeInstanceOf(FireflyError);
    await expect(service.createCategory({ name: "x".repeat(101) })).rejects.toBeInstanceOf(FireflyError);
    await expect(service.createTag({ name: "tag", description: "x".repeat(32_001) })).rejects.toBeInstanceOf(FireflyError);
    expect(client.calls).toEqual([]);
  });
});
