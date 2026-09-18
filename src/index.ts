import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { FireflyClient } from "./client.js";
import { fireflyConfigSchema, type FireflyPluginConfig } from "./config.js";
import { safeError } from "./errors.js";
import { ALLOWED_RULE_ACTION_TYPES, RULE_TRIGGER_TYPES } from "./schemas/rules.js";
import { FireflyService } from "./service.js";

const Id = Type.String({ pattern: "^[1-9][0-9]*$", description: "Canonical non-zero Firefly numeric resource ID (no leading zeroes)." });
const DateOnly = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
  description: "Date in YYYY-MM-DD format.",
});
const Page = Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 }));
const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }));
const RuleMoment = Type.Union([
  Type.Literal("store-journal"),
  Type.Literal("update-journal"),
  Type.Literal("manual-activation"),
]);
const RuleTriggerType = Type.Union(RULE_TRIGGER_TYPES.map((value) => Type.Literal(value)));
const RuleTrigger = Type.Object(
  {
    type: RuleTriggerType,
    value: Type.String({ minLength: 1, maxLength: 1024 }),
    prohibited: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const RuleAction = Type.Object(
  {
    type: Type.Union(ALLOWED_RULE_ACTION_TYPES.map((value) => Type.Literal(value))),
    value: Type.String({
      minLength: 1,
      maxLength: 32_000,
      description: "Action value. Named targets must exactly match an existing Firefly object; text actions use the supplied text.",
    }),
  },
  { additionalProperties: false },
);

function service(config: FireflyPluginConfig, logger: ConstructorParameters<typeof FireflyClient>[1]) {
  return new FireflyService(new FireflyClient(config, logger), config.allowBestEffortPendingRuleDeletion ?? false);
}

async function safely<T>(operation: () => Promise<T>): Promise<T | { error: ReturnType<typeof safeError> }> {
  try {
    return await operation();
  } catch (error) {
    return { error: safeError(error) };
  }
}

export default defineToolPlugin({
  id: "openclaw-firefly",
  name: "Firefly III",
  description: "Safely inspect Firefly III and manage inactive, OpenClaw-owned rule proposals.",
  configSchema: fireflyConfigSchema,
  tools: (tool) => [
    tool({
      name: "firefly_transactions_list",
      label: "List Firefly transactions",
      description: "List a bounded page of Firefly transaction groups.",
      parameters: Type.Object(
        {
          page: Page,
          limit: Limit,
          start: Type.Optional(DateOnly),
          end: Type.Optional(DateOnly),
          type: Type.Optional(
            Type.Union(
              ["all", "withdrawal", "withdrawals", "expense", "deposit", "deposits", "income", "transfer", "transfers", "opening_balance", "reconciliation", "special", "specials", "default"].map(
                (value) => Type.Literal(value),
              ),
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listTransactions(params, context.signal)),
    }),
    tool({
      name: "firefly_transaction_get",
      label: "Get Firefly transaction",
      description: "Get one Firefly transaction group by ID.",
      parameters: Type.Object({ id: Id }, { additionalProperties: false }),
      execute: ({ id }, config, context) =>
        safely(() => service(config, context.api.logger).getTransaction(id, context.signal)),
    }),
    tool({
      name: "firefly_transactions_search",
      label: "Search Firefly transactions",
      description: "Search Firefly transactions using Firefly's native search query syntax.",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 4096 }),
          page: Page,
          limit: Limit,
        },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).searchTransactions(params, context.signal)),
    }),
    tool({
      name: "firefly_categories_list",
      label: "List Firefly categories",
      description: "List existing Firefly categories. This plugin never creates categories.",
      parameters: Type.Object(
        { page: Page, limit: Limit, start: Type.Optional(DateOnly), end: Type.Optional(DateOnly) },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listCategories(params, context.signal)),
    }),
    tool({
      name: "firefly_budgets_list",
      label: "List Firefly budgets",
      description: "List existing Firefly budgets so proposals can reuse exact names.",
      parameters: Type.Object(
        { page: Page, limit: Limit, start: Type.Optional(DateOnly), end: Type.Optional(DateOnly) },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listBudgets(params, context.signal)),
    }),
    tool({
      name: "firefly_tags_list",
      label: "List Firefly tags",
      description: "List existing Firefly tags so proposals can reuse exact names.",
      parameters: Type.Object({ page: Page, limit: Limit }, { additionalProperties: false }),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listTags(params, context.signal)),
    }),
    tool({
      name: "firefly_accounts_list",
      label: "List Firefly accounts",
      description: "List existing Firefly accounts for source, destination, and transfer rule actions.",
      parameters: Type.Object({ page: Page, limit: Limit }, { additionalProperties: false }),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listAccounts(params, context.signal)),
    }),
    tool({
      name: "firefly_rules_list",
      label: "List Firefly rules",
      description: "List a bounded page of Firefly rules for duplicate and overlap checks.",
      parameters: Type.Object({ page: Page, limit: Limit }, { additionalProperties: false }),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listRules(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_get",
      label: "Get Firefly rule",
      description: "Get one Firefly rule by ID.",
      parameters: Type.Object({ id: Id }, { additionalProperties: false }),
      execute: ({ id }, config, context) =>
        safely(() => service(config, context.api.logger).getRule(id, context.signal)),
    }),
    tool({
      name: "firefly_rule_groups_list",
      label: "List Firefly rule groups",
      description: "List existing Firefly rule groups. Rule groups cannot be changed by this plugin.",
      parameters: Type.Object({ page: Page, limit: Limit }, { additionalProperties: false }),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listRuleGroups(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_create_pending",
      label: "Create pending Firefly rule",
      description: "Create an inactive, marked Firefly rule proposal using only the curated metadata, text, account, and transfer-conversion actions.",
      parameters: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 100 }),
          description: Type.Optional(Type.String({ maxLength: 32_000 })),
          ruleGroupId: Id,
          trigger: Type.Optional(RuleMoment),
          strict: Type.Optional(Type.Boolean()),
          stopProcessing: Type.Optional(Type.Boolean()),
          order: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
          triggers: Type.Array(RuleTrigger, { minItems: 1, maxItems: 20 }),
          actions: Type.Array(RuleAction, { minItems: 1, maxItems: 20 }),
        },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).createPendingRule(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_test",
      label: "Test Firefly rule",
      description: "Fetch the persisted rule, deterministically compile its triggers to Firefly search syntax, and return normalized preview matches.",
      parameters: Type.Object(
        {
          id: Id,
          start: Type.Optional(DateOnly),
          end: Type.Optional(DateOnly),
          accountIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 100 })),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).testRule(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_update_pending",
      label: "Update pending Firefly rule",
      description: "Update only an inactive OpenClaw-owned pending rule and keep it inactive.",
      parameters: Type.Object(
        {
          id: Id,
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          description: Type.Optional(Type.String({ maxLength: 32_000 })),
          ruleGroupId: Type.Optional(Id),
          trigger: Type.Optional(RuleMoment),
          strict: Type.Optional(Type.Boolean()),
          stopProcessing: Type.Optional(Type.Boolean()),
          order: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
          triggers: Type.Optional(Type.Array(RuleTrigger, { minItems: 1, maxItems: 20 })),
          actions: Type.Optional(Type.Array(RuleAction, { minItems: 1, maxItems: 20 })),
        },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).updatePendingRule(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_confirm_pending",
      label: "Confirm pending Firefly rule",
      description: "After explicit user approval, activate exactly the reviewed OpenClaw-owned pending proposal digest.",
      parameters: Type.Object({ id: Id, expectedProposalDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, { additionalProperties: false }),
      execute: ({ id, expectedProposalDigest }, config, context) =>
        safely(() => service(config, context.api.logger).confirmPendingRule(id, expectedProposalDigest, context.signal)),
    }),
    tool({
      name: "firefly_rule_reject_pending",
      label: "Reject pending Firefly rule",
      description: "Delete an inactive OpenClaw-owned pending rule only when allowBestEffortPendingRuleDeletion is explicitly enabled and no external rule writers exist.",
      parameters: Type.Object({ id: Id }, { additionalProperties: false }),
      execute: ({ id }, config, context) =>
        safely(() => service(config, context.api.logger).rejectPendingRule(id, context.signal)),
    }),
  ],
});
