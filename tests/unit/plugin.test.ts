import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import plugin from "../../src/index.js";

describe("tool plugin metadata", () => {
  it("exports the constrained creation and historical execution tools", () => {
    const metadata = getToolPluginMetadata(plugin);
    expect(metadata?.tools.map((tool) => tool.name)).toEqual([
      "firefly_transactions_list",
      "firefly_transaction_get",
      "firefly_transactions_search",
      "firefly_categories_list",
      "firefly_expense_account_create",
      "firefly_category_create",
      "firefly_budgets_list",
      "firefly_tags_list",
      "firefly_tag_create",
      "firefly_accounts_list",
      "firefly_rules_list",
      "firefly_rule_get",
      "firefly_rule_groups_list",
      "firefly_rule_create_pending",
      "firefly_rule_test",
      "firefly_rule_execute",
      "firefly_rule_update_pending",
      "firefly_rule_confirm_pending",
      "firefly_rule_reject_pending",
    ]);
    expect(metadata?.tools.some((tool) => tool.name.includes("trigger"))).toBe(false);
    expect(metadata?.tools.some((tool) => tool.name.includes("http_request"))).toBe(false);
  });
});
