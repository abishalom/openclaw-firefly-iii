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
const CreationName = Type.String({ minLength: 1, maxLength: 1024 });
const CategoryName = Type.String({ minLength: 1, maxLength: 100 });
const Notes = Type.Optional(Type.String({ maxLength: 32_000 }));
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
    active: Type.Optional(Type.Boolean()),
    stopProcessing: Type.Optional(Type.Boolean()),
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
    active: Type.Optional(Type.Boolean()),
    stopProcessing: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function service(config: FireflyPluginConfig, logger: ConstructorParameters<typeof FireflyClient>[1]) {
  return new FireflyService(new FireflyClient(config, logger));
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
  description: "Safely inspect Firefly III and manage OpenClaw-managed rules.",
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
      description: "List existing Firefly categories.",
      parameters: Type.Object(
        { page: Page, limit: Limit, start: Type.Optional(DateOnly), end: Type.Optional(DateOnly) },
        { additionalProperties: false },
      ),
      execute: (params, config, context) =>
        safely(() => service(config, context.api.logger).listCategories(params, context.signal)),
    }),
    tool({
      name: "firefly_expense_account_create",
      label: "Create Firefly expense account",
      description: "Create an expense account with a name and optional notes. The account type is always expense.",
      parameters: Type.Object({ name: CreationName, notes: Notes }, { additionalProperties: false }),
      execute: (params, config, context) => safely(() => service(config, context.api.logger).createExpenseAccount(params, context.signal)),
    }),
    tool({
      name: "firefly_category_create",
      label: "Create Firefly category",
      description: "Create a Firefly category with a name and optional notes.",
      parameters: Type.Object({ name: CategoryName, notes: Notes }, { additionalProperties: false }),
      execute: (params, config, context) => safely(() => service(config, context.api.logger).createCategory(params, context.signal)),
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
      name: "firefly_tag_create",
      label: "Create Firefly tag",
      description: "Create a Firefly tag with a name and optional description.",
      parameters: Type.Object({ name: CreationName, description: Notes }, { additionalProperties: false }),
      execute: (params, config, context) => safely(() => service(config, context.api.logger).createTag(params, context.signal)),
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
      name: "firefly_rule_create",
      label: "Create Firefly rule",
      description: "Create an inactive OpenClaw-managed Firefly rule using supported triggers and actions. Creation does not execute historical transactions.",
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
        safely(() => service(config, context.api.logger).createRule(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_test",
      label: "Test Firefly rule",
      description: "Fetch the persisted rule, compile its supported triggers to Firefly search syntax, and return preview examples, count when known, truncation, and scope. This never executes history.",
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
      name: "firefly_rule_execute",
      label: "Execute Firefly rule historically",
      description: "After explicit approval, execute an active OpenClaw-managed rule once against full history: all accounts and all dates. `confirmed: true` records this invocation's confirmation step, not independent proof of human approval. Preview and review the current rule first; filtered previews never narrow this execution scope. This does not activate the rule.",
      parameters: Type.Object({ id: Id, confirmed: Type.Literal(true) }, { additionalProperties: false }),
      execute: ({ id, confirmed }, config, context) => safely(() => service(config, context.api.logger).executeRule(id, confirmed, context.signal)),
    }),
    tool({
      name: "firefly_rule_update",
      label: "Update Firefly rule",
      description: "Update only an inactive OpenClaw-managed rule and keep it inactive. Omitted fields are preserved; supplied triggers or actions replace the full corresponding array, so read and copy every entry, including prohibited, active, and stopProcessing flags, before changing one entry.",
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
        safely(() => service(config, context.api.logger).updateRule(params, context.signal)),
    }),
    tool({
      name: "firefly_rule_activate",
      label: "Activate Firefly rule",
      description: "After explicit approval, activate an OpenClaw-managed rule. Activation enables future configured rule processing only; it never executes historical transactions.",
      parameters: Type.Object({ id: Id, confirmed: Type.Literal(true) }, { additionalProperties: false }),
      execute: ({ id, confirmed }, config, context) =>
        safely(() => service(config, context.api.logger).activateRule(id, confirmed, context.signal)),
    }),
    tool({
      name: "firefly_rule_deactivate",
      label: "Deactivate Firefly rule",
      description: "After explicit approval, deactivate an OpenClaw-managed rule so it can be edited. Deactivation never executes historical transactions.",
      parameters: Type.Object({ id: Id, confirmed: Type.Literal(true) }, { additionalProperties: false }),
      execute: ({ id, confirmed }, config, context) =>
        safely(() => service(config, context.api.logger).deactivateRule(id, confirmed, context.signal)),
    }),
    tool({
      name: "firefly_rule_delete",
      label: "Delete Firefly rule",
      description: "After explicit approval, delete an inactive OpenClaw-managed rule. Active rules must be deactivated first.",
      parameters: Type.Object({ id: Id, confirmed: Type.Literal(true) }, { additionalProperties: false }),
      execute: ({ id, confirmed }, config, context) =>
        safely(() => service(config, context.api.logger).deleteRule(id, confirmed, context.signal)),
    }),
  ],
});
