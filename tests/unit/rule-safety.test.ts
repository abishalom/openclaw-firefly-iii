import { describe, expect, it } from "vitest";
import { FireflyError } from "../../src/errors.js";
import {
  assertAllowedActions,
  assertAllowedTriggers,
  assertInactive,
  assertManaged,
  formatManagedDescription,
  isManaged,
  parseManagedDescription,
} from "../../src/rule-safety.js";
import { normalizeRuleSingle, type NormalizedRule } from "../../src/schemas/rules.js";

function rule(overrides: Partial<NormalizedRule> = {}): NormalizedRule {
  return {
    id: "1",
    title: "Managed",
    description: formatManagedDescription("User note"),
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
    managed: true,
    ...overrides,
  };
}

describe("managed rule safety", () => {
  it("formats a single managed header and preserves human description losslessly", () => {
    const humanDescription = "  First line & <tag>\n\nLast line  ";
    const description = formatManagedDescription(humanDescription);
    expect(description).toBe(`[openclaw-firefly:managed:v1]\n${humanDescription}`);
    expect(parseManagedDescription(description)).toEqual({ marker: "managed:v1", userDescription: humanDescription });
    expect(formatManagedDescription()).toBe("[openclaw-firefly:managed:v1]");
    expect(() => formatManagedDescription("x".repeat(32_768))).toThrowError(/too long/u);
  });

  it("recognizes only anchored managed and legacy headers without checking legacy metadata", () => {
    const legacyPending = "[openclaw-firefly:pending:v1;proposal=stale;digest=wrong;created=not-a-date;expires=expired]\nPending note";
    const legacyConfirmed = "[openclaw-firefly:confirmed:v1;anything=old]\nConfirmed note";
    expect(parseManagedDescription(legacyPending)).toEqual({ marker: "pending:v1", userDescription: "Pending note" });
    expect(parseManagedDescription(legacyConfirmed)).toEqual({ marker: "confirmed:v1", userDescription: "Confirmed note" });
    expect(parseManagedDescription("note\n[openclaw-firefly:managed:v1]")).toBeNull();
    expect(parseManagedDescription("[openclaw-firefly:managed:v1] extra")).toBeNull();
    expect(parseManagedDescription("[openclaw-firefly:pending:v2]\nNote")).toBeNull();
  });

  it("checks managed ownership and inactive state independently", () => {
    expect(isManaged(rule())).toBe(true);
    expect(() => assertManaged(rule({ description: "ordinary", managed: false }))).toThrowError(FireflyError);
    expect(() => assertInactive(rule({ active: true }))).toThrowError(FireflyError);
    expect(() => {
      assertManaged(rule());
      assertInactive(rule());
    }).not.toThrow();
  });

  it("normalizes managed state while retaining editable trigger and action flags", () => {
    const normalized = normalizeRuleSingle({
      data: {
        id: "1",
        attributes: {
          title: "Managed",
          description: "[openclaw-firefly:managed:v1]\nA &amp; &lt;B&gt;",
          rule_group_id: "2",
          trigger: "store-journal",
          active: false,
          strict: false,
          stop_processing: true,
          triggers: [{ type: "description_contains", value: "MARKET", prohibited: true, active: true, stop_processing: true, order: 3 }],
          actions: [{ type: "set_category", value: "Groceries", active: true, stop_processing: true, order: 4 }],
        },
      },
    });
    expect(normalized).toMatchObject({ managed: true, active: false, description: "[openclaw-firefly:managed:v1]\nA & <B>", strict: false, stopProcessing: true });
    expect(normalized.triggers[0]).toMatchObject({ prohibited: true, active: true, stopProcessing: true, order: 3 });
    expect(normalized.actions[0]).toMatchObject({ active: true, stopProcessing: true, order: 4 });
  });

  it("keeps the action allowlist and safety checks", () => {
    expect(() => assertAllowedActions([{ type: "set_category", value: "Groceries" }])).not.toThrow();
    expect(() => assertAllowedActions([{ type: "delete_transaction", value: "x", active: true }])).toThrowError(/not allowed/u);
    expect(() => assertAllowedActions([])).toThrowError(/1 to 20/u);
    expect(() => assertAllowedActions([{ type: "set_category", value: "" }])).toThrowError(/non-empty/u);
    expect(() => assertAllowedActions([
      { type: "add_tag", value: "recurring" },
      { type: "remove_tag", value: "recurring" },
    ])).toThrowError(/cannot both add and remove/u);
  });

  it("keeps trigger validation", () => {
    expect(() => assertAllowedTriggers([{ type: "description_contains", value: "MARKET" }])).not.toThrow();
    expect(() => assertAllowedTriggers([])).toThrowError(/trigger/u);
    expect(() => assertAllowedTriggers([{ type: "delete_transaction", value: "x" } as never])).toThrowError(/not supported/u);
  });
});
