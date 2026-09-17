import { describe, expect, it } from "vitest";
import { FireflyError } from "../../src/errors.js";
import {
  assertAllowedActions,
  assertPendingRule,
  createPendingDescription,
  proposalDigest,
  parsePendingDescription,
  updatePendingDescription,
} from "../../src/rule-safety.js";
import type { NormalizedRule } from "../../src/schemas/rules.js";

function rule(overrides: Partial<NormalizedRule> = {}): NormalizedRule {
  const base = {
    id: "1",
    title: "Proposal",
    description: null,
    order: 1,
    ruleGroupId: "2",
    ruleGroupTitle: "Default",
    trigger: "store-journal",
    active: false,
    strict: true,
    stopProcessing: false,
    createdAt: null,
    updatedAt: null,
    triggers: [{ type: "description_contains", value: "MARKET", prohibited: false, active: true, stopProcessing: false, order: 1 }],
    actions: [{ type: "set_category", value: "Groceries", active: true, stopProcessing: false, order: 1 }],
    pending: true,
    pendingExpiresAt: "2026-09-18T12:00:00.000Z",
    proposalDigest: null,
  } satisfies NormalizedRule;
  const digest = proposalDigest(base, "User note");
  return { ...base, description: createPendingDescription("User note", digest, new Date("2026-09-17T12:00:00.000Z"), "123e4567-e89b-42d3-a456-426614174000"), proposalDigest: digest, ...overrides };
}

describe("pending rule safety", () => {
  it("round-trips an anchored ownership marker and preserves its identity on edit", () => {
    const description = rule().description;
    const marker = parsePendingDescription(description);
    expect(marker).toMatchObject({
      proposalId: "123e4567-e89b-42d3-a456-426614174000",
      userDescription: "User note",
    });
    const updated = updatePendingDescription(marker!, marker!.proposalDigest, "Revised note");
    expect(parsePendingDescription(updated)).toMatchObject({
      proposalId: marker?.proposalId,
      createdAt: marker?.createdAt,
      expiresAt: marker?.expiresAt,
      userDescription: "Revised note",
    });
  });

  it("refuses ordinary and active rules", () => {
    expect(() => assertPendingRule(rule({ description: "ordinary" }))).toThrowError(FireflyError);
    expect(() => assertPendingRule(rule({ active: true }))).toThrowError(FireflyError);
  });

  it("allows only set_category and rejects dangerous actions", () => {
    expect(() => assertAllowedActions([{ type: "set_category", value: "Groceries" }])).not.toThrow();
    expect(() => assertAllowedActions([{ type: "delete_transaction", value: "x", active: true }])).toThrowError(
      /not allowed/u,
    );
    expect(() => assertAllowedActions([{ type: "set_amount", value: "0", active: true }])).toThrowError(
      /not allowed/u,
    );
  });

  it("requires a non-empty category", () => {
    expect(() => assertAllowedActions([{ type: "set_category", value: "" }])).toThrowError(/non-empty/u);
  });
});
