import type { FireflyClient } from "./client.js";
import { FireflyError } from "./errors.js";
import {
  assertAllowedActions,
  assertAllowedTriggers,
  assertInactive,
  assertManaged,
  formatManagedDescription,
} from "./rule-safety.js";
import { compileRulePreview } from "./rule-preview.js";
import { normalizeAccountCollection } from "./schemas/accounts.js";
import {
  normalizeCreatedCategory,
  normalizeCreatedExpenseAccount,
  normalizeCreatedTag,
} from "./schemas/created.js";
import { normalizeBudgetCollection, normalizeTagCollection } from "./schemas/metadata.js";
import {
  normalizeCategoryCollection,
  normalizeRuleCollection,
  normalizeRuleGroupCollection,
  normalizeRuleSingle,
  type NormalizedRule,
  type RuleActionInput,
  type RuleMoment,
  type RuleTriggerInput,
} from "./schemas/rules.js";
import {
  normalizeTransactionCollection,
  normalizeTransactionSingle,
  type NormalizedTransactionGroup,
  type TransactionPage,
} from "./schemas/transactions.js";

export interface PageParams {
  page?: number;
  limit?: number;
}
export interface TransactionListParams extends PageParams {
  start?: string;
  end?: string;
  type?: string;
}
export interface TransactionSearchParams extends PageParams {
  query: string;
}
export interface CategoryListParams extends PageParams {
  start?: string;
  end?: string;
}
export interface BudgetListParams extends PageParams {
  start?: string;
  end?: string;
}
export interface RuleTestParams {
  id: string;
  start?: string;
  end?: string;
  accountIds?: string[];
  maxResults?: number;
}
export interface RulePreviewResult extends TransactionPage {
  ruleId: string;
  strict: boolean;
  queries: string[];
  executedQueries: number;
  previewEngine: "firefly-search";
  executionScope: "all-accounts-all-dates" | "limited-preview-only";
  executionBackend: "firefly-v6.7.2-rule-trigger";
  truncated: boolean;
}
export interface CreateRuleInput {
  title: string;
  description?: string;
  ruleGroupId: string;
  trigger?: RuleMoment;
  strict?: boolean;
  stopProcessing?: boolean;
  order?: number;
  triggers: RuleTriggerInput[];
  actions: RuleActionInput[];
}
export interface UpdateRuleInput {
  id: string;
  title?: string;
  description?: string;
  ruleGroupId?: string;
  trigger?: RuleMoment;
  strict?: boolean;
  stopProcessing?: boolean;
  order?: number;
  triggers?: RuleTriggerInput[];
  actions?: RuleActionInput[];
}
export interface RuleStateResult {
  id: string;
  changed: boolean;
  rule: NormalizedRule;
}

export class FireflyService {
  constructor(private readonly client: FireflyClient) {}

  async createExpenseAccount(input: { name: string; notes?: string }, signal?: AbortSignal) {
    validateCreationText(input.name, "name", 1024);
    if (input.notes !== undefined) validateOptionalText(input.notes, "notes", 32_000);
    return this.createWithUncertainOutcome(() =>
      this.client
        .post<unknown>(
          "/accounts",
          { name: input.name, type: "expense", ...(input.notes === undefined ? {} : { notes: input.notes }) },
          withSignal(signal),
        )
        .then(normalizeCreatedExpenseAccount),
    );
  }

  async createCategory(input: { name: string; notes?: string }, signal?: AbortSignal) {
    validateCreationText(input.name, "name", 100);
    if (input.notes !== undefined) validateOptionalText(input.notes, "notes", 32_000);
    return this.createWithUncertainOutcome(() =>
      this.client
        .post<unknown>(
          "/categories",
          { name: input.name, ...(input.notes === undefined ? {} : { notes: input.notes }) },
          withSignal(signal),
        )
        .then(normalizeCreatedCategory),
    );
  }

  async createTag(input: { name: string; description?: string }, signal?: AbortSignal) {
    validateCreationText(input.name, "name", 1024);
    if (input.description !== undefined) validateOptionalText(input.description, "description", 32_000);
    return this.createWithUncertainOutcome(() =>
      this.client
        .post<unknown>(
          "/tags",
          { tag: input.name, ...(input.description === undefined ? {} : { description: input.description }) },
          withSignal(signal),
        )
        .then(normalizeCreatedTag),
    );
  }

  async listTransactions(params: TransactionListParams, signal?: AbortSignal) {
    return normalizeTransactionCollection(
      await this.client.get<unknown>("/transactions", {
        query: { page: params.page, limit: params.limit, start: params.start, end: params.end, type: params.type },
        ...withSignal(signal),
      }),
    );
  }

  async getTransaction(id: string, signal?: AbortSignal) {
    return normalizeTransactionSingle(
      await this.client.get<unknown>(`/transactions/${resourceId(id)}`, withSignal(signal)),
    );
  }

  async searchTransactions(params: TransactionSearchParams, signal?: AbortSignal) {
    return normalizeTransactionCollection(
      await this.client.get<unknown>("/search/transactions", {
        query: { query: params.query, page: params.page, limit: params.limit },
        ...withSignal(signal),
      }),
    );
  }

  async listCategories(params: CategoryListParams, signal?: AbortSignal) {
    return normalizeCategoryCollection(
      await this.client.get<unknown>("/categories", {
        query: { page: params.page, limit: params.limit, start: params.start, end: params.end },
        ...withSignal(signal),
      }),
    );
  }

  async listBudgets(params: BudgetListParams, signal?: AbortSignal) {
    return normalizeBudgetCollection(
      await this.client.get<unknown>("/budgets", {
        query: { page: params.page, limit: params.limit, start: params.start, end: params.end },
        ...withSignal(signal),
      }),
    );
  }

  async listTags(params: PageParams, signal?: AbortSignal) {
    return normalizeTagCollection(
      await this.client.get<unknown>("/tags", {
        query: { page: params.page, limit: params.limit },
        ...withSignal(signal),
      }),
    );
  }

  async listAccounts(params: PageParams, signal?: AbortSignal) {
    return normalizeAccountCollection(
      await this.client.get<unknown>("/accounts", {
        query: { type: "all", page: params.page, limit: params.limit },
        ...withSignal(signal),
      }),
    );
  }

  async listRules(params: PageParams, signal?: AbortSignal) {
    return normalizeRuleCollection(
      await this.client.get<unknown>("/rules", {
        query: { page: params.page, limit: params.limit },
        ...withSignal(signal),
      }),
    );
  }

  async getRule(id: string, signal?: AbortSignal): Promise<NormalizedRule> {
    return normalizeRuleSingle(
      await this.client.get<unknown>(`/rules/${resourceId(id)}`, withSignal(signal)),
    );
  }

  async listRuleGroups(params: PageParams, signal?: AbortSignal) {
    return normalizeRuleGroupCollection(
      await this.client.get<unknown>("/rule-groups", {
        query: { page: params.page, limit: params.limit },
        ...withSignal(signal),
      }),
    );
  }

  async testRule(params: RuleTestParams, signal?: AbortSignal): Promise<RulePreviewResult> {
    const id = resourceId(params.id);
    const maxResults = params.maxResults ?? 100;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
      throw new FireflyError("FIREFLY_VALIDATION_FAILED", "maxResults must be an integer from 1 to 500.");
    }
    if (params.start !== undefined) validateDateOnly(params.start, "start");
    if (params.end !== undefined) validateDateOnly(params.end, "end");
    if (params.accountIds !== undefined && (params.accountIds.length < 1 || params.accountIds.length > 100)) {
      throw new FireflyError("FIREFLY_VALIDATION_FAILED", "accountIds must contain 1 to 100 Firefly account IDs.");
    }

    const rule = await this.getRule(id, signal);
    const compiled = compileRulePreview(rule, {
      ...(params.start === undefined ? {} : { start: params.start }),
      ...(params.end === undefined ? {} : { end: params.end }),
      ...(params.accountIds === undefined ? {} : { accountIds: params.accountIds.map(resourceId) }),
    });
    const transactions: NormalizedTransactionGroup[] = [];
    const seen = new Set<string>();
    let truncated = false;
    let total: number | null = 0;
    let executedQueries = 0;

    for (let index = 0; index < compiled.queries.length; index += 1) {
      const query = compiled.queries[index];
      if (query === undefined) continue;
      const result = await this.searchPreviewQuery(query, maxResults, signal);
      executedQueries += 1;
      total = compiled.strict ? result.total : null;
      for (const transaction of result.transactions) {
        if (seen.has(transaction.id)) continue;
        seen.add(transaction.id);
        if (transactions.length < maxResults) transactions.push(transaction);
        else truncated = true;
      }
      truncated ||= result.truncated;
      if (compiled.triggerStopProcessing[index] && result.transactions.length > 0) break;
      if (transactions.length >= maxResults && index < compiled.queries.length - 1) {
        truncated = true;
        break;
      }
    }

    return {
      ruleId: id,
      strict: compiled.strict,
      queries: compiled.queries,
      executedQueries,
      previewEngine: "firefly-search",
      executionScope: params.start === undefined && params.end === undefined && params.accountIds === undefined
        ? "all-accounts-all-dates"
        : "limited-preview-only",
      executionBackend: "firefly-v6.7.2-rule-trigger",
      truncated,
      transactions,
      pagination: {
        total,
        count: transactions.length,
        perPage: maxResults,
        currentPage: 1,
        totalPages: compiled.strict && !truncated ? 1 : null,
      },
    };
  }

  async createRule(input: CreateRuleInput, signal?: AbortSignal): Promise<NormalizedRule> {
    validateRuleTitle(input.title);
    const groupId = resourceId(input.ruleGroupId);
    assertAllowedTriggers(input.triggers);
    assertAllowedActions(input.actions);
    await this.assertActionTargetsExist(input.actions, signal);

    const payload = {
      title: input.title,
      description: formatManagedDescription(input.description),
      rule_group_id: groupId,
      active: false,
      trigger: input.trigger ?? "store-journal",
      strict: input.strict ?? true,
      stop_processing: input.stopProcessing ?? false,
      ...(input.order === undefined ? {} : { order: input.order }),
      triggers: input.triggers.map(triggerPayload),
      actions: input.actions.map(actionPayload),
    };
    let created: NormalizedRule;
    try {
      created = normalizeRuleSingle(await this.client.post<unknown>("/rules", payload, withSignal(signal)));
    } catch (error) {
      throw mutationUncertain("Rule creation may have succeeded; inspect Firefly before creating another rule.", error);
    }

    const stored = await this.readAfterMutation(created.id, signal);
    if (stored.active) {
      throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly created rule ${stored.id} active despite the inactive request.`);
    }
    verifyStoredManagedDescription(stored, input.description ?? "");
    verifyCreate(stored, input);
    return stored;
  }

  async updateRule(input: UpdateRuleInput, signal?: AbortSignal): Promise<NormalizedRule> {
    const id = resourceId(input.id);
    if (input.ruleGroupId !== undefined) resourceId(input.ruleGroupId);

    const existing = await this.getRule(id, signal);
    const marker = assertManaged(existing);
    const userDescription = input.description === undefined ? marker.userDescription : input.description;
    assertInactive(existing);
    if (input.title !== undefined) validateRuleTitle(input.title);
    if (input.triggers !== undefined) assertAllowedTriggers(input.triggers);
    if (input.actions !== undefined) assertAllowedActions(input.actions);

    const actions = input.actions ?? existing.actions;
    assertAllowedActions(actions);
    await this.assertActionTargetsExist(actions, signal);

    const payload: Record<string, unknown> = {
      description: formatManagedDescription(userDescription),
    };
    if (input.title !== undefined) payload.title = input.title;
    if (input.ruleGroupId !== undefined) payload.rule_group_id = resourceId(input.ruleGroupId);
    if (input.trigger !== undefined) payload.trigger = input.trigger;
    if (input.strict !== undefined) payload.strict = input.strict;
    if (input.stopProcessing !== undefined) payload.stop_processing = input.stopProcessing;
    if (input.order !== undefined) payload.order = input.order;
    if (input.triggers !== undefined) payload.triggers = input.triggers.map(triggerPayload);
    if (input.actions !== undefined) payload.actions = input.actions.map(actionPayload);

    try {
      await this.client.put<unknown>(`/rules/${id}`, payload, withSignal(signal));
    } catch (error) {
      throw mutationUncertain(`Rule ${id} update may have succeeded; inspect it before trying again.`, error);
    }

    const stored = await this.readAfterMutation(id, signal);
    if (stored.active) {
      throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly unexpectedly activated rule ${id} during update.`);
    }
    verifyStoredManagedDescription(stored, userDescription);
    verifyUpdate(stored, input);
    return stored;
  }

  async deleteRule(rawId: string, confirmed: boolean, signal?: AbortSignal): Promise<{ id: string; deleted: true }> {
    const id = resourceId(rawId);
    requireConfirmation(confirmed);
    const rule = await this.getRule(id, signal);
    assertManaged(rule);
    assertInactive(rule);
    try {
      await this.client.delete(`/rules/${id}`, withSignal(signal));
    } catch (error) {
      throw mutationUncertain(`Rule ${id} deletion may have succeeded; inspect Firefly before trying again.`, error);
    }
    return { id, deleted: true };
  }

  async activateRule(rawId: string, confirmed: boolean, signal?: AbortSignal): Promise<RuleStateResult> {
    return this.setRuleActive(rawId, true, confirmed, signal);
  }

  async deactivateRule(rawId: string, confirmed: boolean, signal?: AbortSignal): Promise<RuleStateResult> {
    return this.setRuleActive(rawId, false, confirmed, signal);
  }

  async executeRule(rawId: string, confirmed: boolean, signal?: AbortSignal): Promise<{
    id: string;
    executed: true;
    executionScope: "all-accounts-all-dates";
  }> {
    const id = resourceId(rawId);
    requireConfirmation(confirmed);
    await this.assertSupportedExecutionVersion(signal);
    const rule = await this.getRule(id, signal);
    assertManaged(rule);
    if (!rule.active) {
      throw new FireflyError("FIREFLY_RULE_MUST_BE_ACTIVE", `Rule ${id} must be active for historical execution.`);
    }
    assertAllowedTriggers(rule.triggers);
    assertAllowedActions(rule.actions);
    await this.assertActionTargetsExist(rule.actions, signal);
    try {
      const response = await this.client.post<unknown>(`/rules/${id}/trigger`, { accounts: [] }, withSignal(signal));
      if (response !== undefined) {
        throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly did not return the required empty 204 response for historical execution.");
      }
    } catch (error) {
      throw mutationUncertain(`Historical execution of rule ${id} may have started; inspect Firefly before trying again.`, error);
    }
    return { id, executed: true, executionScope: "all-accounts-all-dates" };
  }

  private async setRuleActive(rawId: string, active: boolean, confirmed: boolean, signal?: AbortSignal): Promise<RuleStateResult> {
    const id = resourceId(rawId);
    requireConfirmation(confirmed);
    const existing = await this.getRule(id, signal);
    const marker = assertManaged(existing);
    if (existing.active === active) return { id, changed: false, rule: existing };

    if (active) {
      assertAllowedTriggers(existing.triggers);
      assertAllowedActions(existing.actions);
      await this.assertActionTargetsExist(existing.actions, signal);
    }
    try {
      await this.client.put<unknown>(
        `/rules/${id}`,
        { active, description: formatManagedDescription(marker.userDescription) },
        withSignal(signal),
      );
    } catch (error) {
      throw mutationUncertain(`Rule ${id} ${active ? "activation" : "deactivation"} may have succeeded; inspect it before trying again.`, error);
    }

    const stored = await this.readAfterMutation(id, signal);
    if (stored.active !== active) {
      throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly did not ${active ? "activate" : "deactivate"} rule ${id}.`);
    }
    verifyStoredManagedDescription(stored, marker.userDescription);
    return { id, changed: true, rule: stored };
  }

  private async readAfterMutation(id: string, signal?: AbortSignal): Promise<NormalizedRule> {
    try {
      return await this.getRule(id, signal);
    } catch (error) {
      throw new FireflyError(
        "FIREFLY_MUTATION_UNCERTAIN",
        `Rule ${id} was written but its current state could not be read; inspect Firefly.`,
        undefined,
        { cause: error },
      );
    }
  }

  private async assertSupportedExecutionVersion(signal?: AbortSignal): Promise<void> {
    const about = await this.client.get<unknown>("/about", withSignal(signal));
    const version = about !== null && typeof about === "object" && "data" in about
      && about.data !== null && typeof about.data === "object" && "version" in about.data
      ? about.data.version
      : undefined;
    if (typeof version !== "string" || version.trim() === "") {
      throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly returned an invalid /about response.");
    }
    if (version !== "6.7.2") {
      throw new FireflyError("FIREFLY_RULE_UNSAFE", "Historical execution is supported only on a verified Firefly III v6.7.2 backend.");
    }
  }

  private async createWithUncertainOutcome<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isUncertain(error)) {
        throw mutationUncertain("Creation may have succeeded but could not be verified. Inspect Firefly before attempting another creation.", error);
      }
      throw error;
    }
  }

  private async searchPreviewQuery(query: string, maxResults: number, signal?: AbortSignal): Promise<{
    transactions: NormalizedTransactionGroup[];
    total: number | null;
    truncated: boolean;
  }> {
    const transactions: NormalizedTransactionGroup[] = [];
    let page = 1;
    let total: number | null = null;
    let truncated = false;
    while (transactions.length < maxResults) {
      const limit = Math.min(100, maxResults - transactions.length);
      const result = await this.searchTransactions({ query, page, limit }, signal);
      transactions.push(...result.transactions.slice(0, maxResults - transactions.length));
      total = result.pagination.total;
      const hasAnotherPage = result.pagination.totalPages === null
        ? result.transactions.length >= limit
        : result.pagination.currentPage < result.pagination.totalPages;
      if (!hasAnotherPage || result.transactions.length === 0) break;
      if (transactions.length >= maxResults) {
        truncated = true;
        break;
      }
      page = result.pagination.currentPage + 1;
    }
    if (total !== null && total > transactions.length) truncated = true;
    return { transactions, total, truncated };
  }

  private async assertActionTargetsExist(actions: readonly { type: string; value: string | null }[], signal?: AbortSignal): Promise<void> {
    const categories = actions.filter((action) => action.type === "set_category").map((action) => action.value).filter((value): value is string => value !== null);
    if (categories.length > 0) {
      const names = new Set((await this.listCategories({ page: 1, limit: 65_536 }, signal)).categories.map((category) => category.name));
      const missing = categories.find((name) => !names.has(name));
      if (missing !== undefined) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Category ${JSON.stringify(missing)} does not exist in Firefly.`);
    }

    const budgets = actions.filter((action) => action.type === "set_budget").map((action) => action.value).filter((value): value is string => value !== null);
    if (budgets.length > 0) {
      const names = new Set((await this.listBudgets({ page: 1, limit: 65_536 }, signal)).budgets.filter((budget) => budget.active).map((budget) => budget.name));
      const missing = budgets.find((name) => !names.has(name));
      if (missing !== undefined) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Active budget ${JSON.stringify(missing)} does not exist in Firefly.`);
    }

    const tags = actions.filter((action) => action.type === "add_tag" || action.type === "remove_tag").map((action) => action.value).filter((value): value is string => value !== null);
    if (tags.length > 0) {
      const names = new Set((await this.listTags({ page: 1, limit: 65_536 }, signal)).tags.map((tag) => tag.name));
      const missing = tags.find((name) => !names.has(name));
      if (missing !== undefined) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Tag ${JSON.stringify(missing)} does not exist in Firefly.`);
    }

    const accountNames = actions.filter((action) => action.type === "set_source_account" || action.type === "set_destination_account" || action.type === "convert_transfer").map((action) => action.value).filter((value): value is string => value !== null);
    if (accountNames.length > 0) {
      const accounts = (await this.listAccounts({ page: 1, limit: 65_536 }, signal)).accounts.filter((account) => account.active);
      for (const name of accountNames) {
        const matches = accounts.filter((account) => account.name === name);
        if (matches.length === 0) {
          throw new FireflyError("FIREFLY_RULE_UNSAFE", `Active account ${JSON.stringify(name)} does not exist in Firefly.`);
        }
        if (matches.length > 1) {
          throw new FireflyError("FIREFLY_RULE_UNSAFE", `Account name ${JSON.stringify(name)} is ambiguous in Firefly.`);
        }
      }
    }
  }
}

function triggerPayload(trigger: RuleTriggerInput) {
  return {
    type: trigger.type,
    value: trigger.value,
    prohibited: trigger.prohibited ?? false,
    active: trigger.active ?? true,
    stop_processing: trigger.stopProcessing ?? false,
  };
}

function actionPayload(action: RuleActionInput) {
  return {
    type: action.type,
    value: action.value,
    active: action.active ?? true,
    stop_processing: action.stopProcessing ?? false,
  };
}

function verifyCreate(rule: NormalizedRule, input: CreateRuleInput): void {
  if (rule.title !== input.title || rule.ruleGroupId !== input.ruleGroupId || rule.trigger !== (input.trigger ?? "store-journal")
    || rule.strict !== (input.strict ?? true) || rule.stopProcessing !== (input.stopProcessing ?? false)
    || (input.order !== undefined && rule.order !== input.order)) {
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly did not preserve the requested creation of rule ${rule.id}.`);
  }
  verifyRequestedEntries(rule, input);
}

function verifyUpdate(rule: NormalizedRule, input: UpdateRuleInput): void {
  const scalars: Array<[string | boolean | number | null, string | boolean | number | undefined]> = [
    [rule.title, input.title],
    [rule.ruleGroupId, input.ruleGroupId],
    [rule.trigger, input.trigger],
    [rule.strict, input.strict],
    [rule.stopProcessing, input.stopProcessing],
    [rule.order, input.order],
  ];
  if (scalars.some(([actual, expected]) => expected !== undefined && actual !== expected)) {
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly did not preserve the requested update to rule ${rule.id}.`);
  }
  verifyRequestedEntries(rule, input);
}

function verifyStoredManagedDescription(rule: NormalizedRule, userDescription: string): void {
  const marker = assertManaged(rule);
  if (marker.marker !== "managed:v1" || marker.userDescription !== userDescription) {
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly did not preserve the managed description for rule ${rule.id}.`);
  }
}

function verifyRequestedEntries(rule: NormalizedRule, input: Pick<UpdateRuleInput, "triggers" | "actions">): void {
  if (input.triggers !== undefined && !sameTriggers(rule.triggers, input.triggers)) {
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly did not store the requested triggers for rule ${rule.id}.`);
  }
  if (input.actions !== undefined && !sameActions(rule.actions, input.actions)) {
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", `Firefly did not store the requested actions for rule ${rule.id}.`);
  }
}

function sameTriggers(actual: NormalizedRule["triggers"], expected: RuleTriggerInput[]): boolean {
  return actual.length === expected.length && actual.every((trigger, index) => {
    const requested = expected[index];
    return requested !== undefined
      && trigger.type === requested.type
      && trigger.value === requested.value
      && trigger.prohibited === (requested.prohibited ?? false)
      && trigger.active === (requested.active ?? true)
      && trigger.stopProcessing === (requested.stopProcessing ?? false);
  });
}

function sameActions(actual: NormalizedRule["actions"], expected: RuleActionInput[]): boolean {
  return actual.length === expected.length && actual.every((action, index) => {
    const requested = expected[index];
    return requested !== undefined
      && action.type === requested.type
      && action.value === requested.value
      && action.active === (requested.active ?? true)
      && action.stopProcessing === (requested.stopProcessing ?? false);
  });
}

function withSignal(signal: AbortSignal | undefined): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}

function resourceId(id: string): string {
  if (!/^[1-9]\d*$/u.test(id)) {
    throw new FireflyError("FIREFLY_VALIDATION_FAILED", "Firefly resource IDs must be non-zero canonical numeric strings without leading zeroes.");
  }
  return encodeURIComponent(id);
}

function validateDateOnly(value: string, field: "start" | "end"): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must use YYYY-MM-DD format.`);
  }
}

function validateCreationText(value: string, field: string, maxLength: number): void {
  if (value.trim() === "" || value.length > maxLength) {
    throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must contain 1 to ${maxLength} characters.`);
  }
}

function validateOptionalText(value: string, field: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must not exceed ${maxLength} characters.`);
  }
}

function validateRuleTitle(title: string): void {
  if (title.trim() === "" || title.length > 100) {
    throw new FireflyError("FIREFLY_RULE_UNSAFE", "Rule title must contain 1 to 100 characters.");
  }
}

function requireConfirmation(confirmed: boolean): asserts confirmed is true {
  if (confirmed !== true) throw new FireflyError("FIREFLY_CONFIRMATION_REQUIRED", "confirmed must be true.");
}

function isUncertain(error: unknown): boolean {
  return error instanceof FireflyError
    && ["FIREFLY_TIMEOUT", "FIREFLY_NETWORK_ERROR", "FIREFLY_CANCELLED", "FIREFLY_TEMPORARY_FAILURE", "FIREFLY_INVALID_RESPONSE"].includes(error.code);
}

function mutationUncertain(message: string, error: unknown): FireflyError {
  if (isUncertain(error)) {
    return new FireflyError("FIREFLY_MUTATION_UNCERTAIN", message, undefined, { cause: error });
  }
  return error instanceof FireflyError
    ? error
    : new FireflyError("FIREFLY_MUTATION_UNCERTAIN", message, undefined, { cause: error });
}
