import { describe, expect, it } from "vitest";
import { FireflyError } from "../../src/errors.js";
import {
  assertAllowedActions,
  assertExecutionRule,
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
    expect(parsePendingDescription(description!.replace("proposal=123e4567-e89b-42d3-a456-426614174000", "proposal=------------------------------------"))).toBeNull();
    expect(parsePendingDescription(description!.replace("created=2026-09-17T12:00:00.000Z", "created=not-a-date"))).toBeNull();
  });

  it("ignores hidden-trigger numeric gaps but preserves sequence and values", () => {
    const original = rule({
      triggers: [
        { type: "description_contains", value: "MARKET", prohibited: false, active: true, stopProcessing: false, order: 1 },
        { type: "has_no_category", value: "true", prohibited: false, active: true, stopProcessing: false, order: 3 },
      ],
      actions: [
        { type: "set_category", value: "Groceries", active: true, stopProcessing: false, order: 1 },
        { type: "add_tag", value: "reviewed", active: true, stopProcessing: false, order: 4 },
      ],
    });
    const digest = proposalDigest(original, "User note");
    expect(proposalDigest({ ...original, triggers: original.triggers.map((trigger, index) => ({ ...trigger, order: index + 7 })), actions: original.actions.map((action, index) => ({ ...action, order: index + 9 })) }, "User note")).toBe(digest);
    expect(proposalDigest({ ...original, triggers: [...original.triggers].reverse() }, "User note")).not.toBe(digest);
    expect(proposalDigest({ ...original, actions: [{ ...original.actions[0]!, value: "Dining" }, original.actions[1]!] }, "User note")).not.toBe(digest);
  });

  it("refuses ordinary and active rules", () => {
    expect(() => assertPendingRule(rule({ description: "ordinary" }))).toThrowError(FireflyError);
    expect(() => assertPendingRule(rule({ active: true }))).toThrowError(FireflyError);
  });

  it("permits only intact active confirmed OpenClaw rules for execution", () => {
    expect(() => assertExecutionRule(rule())).toThrowError(FireflyError);
    const pending = rule();
    const confirmedDescription = `[openclaw-firefly:confirmed:v1;proposal=123e4567-e89b-42d3-a456-426614174000;digest=${pending.proposalDigest};confirmed=2026-09-17T12:00:00.000Z]\nUser note`;
    expect(() => assertExecutionRule({ ...pending, active: true, description: confirmedDescription })).not.toThrow();
    expect(() => assertExecutionRule({ ...pending, active: true, description: "ordinary" })).toThrowError(FireflyError);
  });

  it("allows category, destination, or one of each and rejects dangerous actions", () => {
    const individuallyAllowed = [
      { type: "set_category", value: "Groceries" },
      { type: "set_budget", value: "Household" },
      { type: "add_tag", value: "recurring" },
      { type: "remove_tag", value: "uncategorized" },
      { type: "set_description", value: "Credit card autopay" },
      { type: "set_notes", value: "Normalized by an approved rule" },
      { type: "set_source_account", value: "Checking" },
      { type: "set_destination_account", value: "Sarah's Tent" },
      { type: "convert_transfer", value: "Credit Card" },
    ] as const;
    for (const action of individuallyAllowed) {
      expect(() => assertAllowedActions([action])).not.toThrow();
    }
    expect(() => assertAllowedActions([
      { type: "set_category", value: "Groceries" },
      { type: "set_destination_account", value: "Sarah's Tent" },
    ])).not.toThrow();
    expect(() => assertAllowedActions([
      { type: "set_budget", value: "Household" },
      { type: "add_tag", value: "recurring" },
      { type: "remove_tag", value: "uncategorized" },
      { type: "set_description", value: "Credit card autopay" },
      { type: "set_notes", value: "Normalized by an approved rule" },
      { type: "set_source_account", value: "Checking" },
      { type: "convert_transfer", value: "Credit Card" },
    ])).not.toThrow();
    expect(() => assertAllowedActions([{ type: "delete_transaction", value: "x", active: true }])).toThrowError(
      /not allowed/u,
    );
    expect(() => assertAllowedActions([{ type: "set_amount", value: "0", active: true }])).toThrowError(
      /not allowed/u,
    );
  });

  it("requires non-empty targets and rejects duplicate action types", () => {
    expect(() => assertAllowedActions([])).toThrowError(/1 to 20/u);
    expect(() => assertAllowedActions([{ type: "set_category", value: "" }])).toThrowError(/non-empty/u);
    expect(() => assertAllowedActions([{ type: "set_destination_account", value: "" }])).toThrowError(/non-empty/u);
    expect(() => assertAllowedActions([
      { type: "set_category", value: "Groceries" },
      { type: "set_category", value: "Dining" },
    ])).toThrowError(/at most one set_category/u);
    expect(() => assertAllowedActions([
      { type: "set_destination_account", value: "Sarah's Tent" },
      { type: "set_destination_account", value: "Other" },
    ])).toThrowError(/at most one set_destination_account/u);
    expect(() => assertAllowedActions([
      { type: "add_tag", value: "recurring" },
      { type: "remove_tag", value: "recurring" },
    ])).toThrowError(/cannot both add and remove/u);
  });
});
