import { describe, expect, it } from "vitest";
import { compileRulePreview } from "../../src/rule-preview.js";
import type { NormalizedRule, NormalizedRuleTrigger } from "../../src/schemas/rules.js";

describe("rule preview compiler", () => {
  it("matches Firefly's UI search query for the persisted strict rule", () => {
    const rule = makeRule([
      trigger("description_is", "SARAHS TENT"),
      trigger("transaction_type", "Withdrawal"),
    ]);

    expect(compileRulePreview(rule)).toEqual({
      strict: true,
      queries: ['description_is:"SARAHS TENT" transaction_type:"Withdrawal"'],
      triggerStopProcessing: [false],
    });
  });

  it("normalizes Firefly aliases, prohibition, context-free triggers, and filters", () => {
    const rule = makeRule([
      trigger("from_account_is", "Checking", true),
      trigger("amount_exactly", "12.50"),
      trigger("has_no_category", "canonicalized by Firefly"),
      trigger("notes_end", 'memo "quoted"'),
    ]);

    expect(compileRulePreview(rule, {
      start: "2026-01-01",
      end: "2026-12-31",
      accountIds: ["3", "9"],
    }).queries).toEqual([
      '-source_account_is:"Checking" amount_is:"12.50" has_no_category:true notes_ends:"memo \\"quoted\\"" date_after:"2026-01-01" date_before:"2026-12-31" account_id:"3,9"',
    ]);
  });

  it("compiles non-strict rules into ordered searches for service-side union", () => {
    const first = trigger("description_contains", "MARKET");
    first.stopProcessing = true;
    const rule = makeRule([first, trigger("destination_account_is", "Groceries")], false);

    expect(compileRulePreview(rule)).toEqual({
      strict: false,
      queries: [
        'description_contains:"MARKET"',
        'destination_account_is:"Groceries"',
      ],
      triggerStopProcessing: [true, false],
    });
  });

  it("fails closed for trigger types outside the plugin's reviewed allowlist", () => {
    const rule = makeRule([trigger("journal_id", "123")]);
    expect(() => compileRulePreview(rule)).toThrowError(/unsupported preview trigger/u);
  });
});

function trigger(type: string, value: string, prohibited = false): NormalizedRuleTrigger {
  return { type, value, prohibited, active: true, stopProcessing: false, order: 1 };
}

function makeRule(triggers: NormalizedRuleTrigger[], strict = true): NormalizedRule {
  return {
    id: "101",
    title: "Preview",
    description: null,
    ruleGroupId: "1",
    ruleGroupTitle: "Default",
    trigger: "store-journal",
    order: 1,
    active: false,
    strict,
    stopProcessing: false,
    createdAt: null,
    updatedAt: null,
    triggers,
    actions: [{ type: "set_category", value: "Groceries", active: true, stopProcessing: false, order: 1 }],
    managed: false,
  };
}
