import type { FireflyClient } from "./client.js";
import { FireflyError } from "./errors.js";
import {
  assertAllowedActions, assertAllowedTriggers, assertPendingRule, createConfirmedDescription,
  createPendingDescription, parsePendingDescription, proposalDigest, updatePendingDescription,
} from "./rule-safety.js";
import { compileRulePreview } from "./rule-preview.js";
import { normalizeCategoryCollection, normalizeRuleCollection, normalizeRuleGroupCollection, normalizeRuleSingle, type NormalizedRule, type RuleActionInput, type RuleMoment, type RuleTriggerInput } from "./schemas/rules.js";
import { normalizeTransactionCollection, normalizeTransactionSingle, type NormalizedTransactionGroup, type TransactionPage } from "./schemas/transactions.js";

export interface PageParams { page?: number; limit?: number; }
export interface TransactionListParams extends PageParams { start?: string; end?: string; type?: string; }
export interface TransactionSearchParams extends PageParams { query: string; }
export interface CategoryListParams extends PageParams { start?: string; end?: string; }
export interface RuleTestParams { id: string; start?: string; end?: string; accountIds?: string[]; maxResults?: number; }
export interface RulePreviewResult extends TransactionPage {
  ruleId: string;
  strict: boolean;
  queries: string[];
  executedQueries: number;
  previewEngine: "firefly-search";
  truncated: boolean;
}
export interface CreatePendingRuleInput { title: string; description?: string; ruleGroupId: string; trigger?: RuleMoment; strict?: boolean; stopProcessing?: boolean; order?: number; triggers: RuleTriggerInput[]; actions: RuleActionInput[]; }
export interface UpdatePendingRuleInput { id: string; title?: string; description?: string; ruleGroupId?: string; trigger?: RuleMoment; strict?: boolean; stopProcessing?: boolean; order?: number; triggers?: RuleTriggerInput[]; actions?: RuleActionInput[]; }

// Shared by all service instances in this Gateway process. Firefly v6.7.2 offers no CAS.
const ruleLocks = new Map<string, Promise<void>>();
async function withRuleLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = ruleLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  ruleLocks.set(id, current);
  await previous;
  try { return await operation(); } finally { release(); if (ruleLocks.get(id) === current) ruleLocks.delete(id); }
}

export class FireflyService {
  constructor(private readonly client: FireflyClient, private readonly allowBestEffortPendingRuleDeletion = false) {}

  async listTransactions(params: TransactionListParams, signal?: AbortSignal) { return normalizeTransactionCollection(await this.client.get<unknown>("/transactions", { query: { page: params.page, limit: params.limit, start: params.start, end: params.end, type: params.type }, ...withSignal(signal) })); }
  async getTransaction(id: string, signal?: AbortSignal) { return normalizeTransactionSingle(await this.client.get<unknown>(`/transactions/${resourceId(id)}`, withSignal(signal))); }
  async searchTransactions(params: TransactionSearchParams, signal?: AbortSignal) { return normalizeTransactionCollection(await this.client.get<unknown>("/search/transactions", { query: { query: params.query, page: params.page, limit: params.limit }, ...withSignal(signal) })); }
  async listCategories(params: CategoryListParams, signal?: AbortSignal) { return normalizeCategoryCollection(await this.client.get<unknown>("/categories", { query: { page: params.page, limit: params.limit, start: params.start, end: params.end }, ...withSignal(signal) })); }
  async listRules(params: PageParams, signal?: AbortSignal) { return normalizeRuleCollection(await this.client.get<unknown>("/rules", { query: { page: params.page, limit: params.limit }, ...withSignal(signal) })); }
  async getRule(id: string, signal?: AbortSignal): Promise<NormalizedRule> { return normalizeRuleSingle(await this.client.get<unknown>(`/rules/${resourceId(id)}`, withSignal(signal))); }
  async listRuleGroups(params: PageParams, signal?: AbortSignal) { return normalizeRuleGroupCollection(await this.client.get<unknown>("/rule-groups", { query: { page: params.page, limit: params.limit }, ...withSignal(signal) })); }
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
    const accountIds = params.accountIds?.map(resourceId);
    const rule = await this.getRule(id, signal);
    const compiled = compileRulePreview(rule, {
      ...(params.start === undefined ? {} : { start: params.start }),
      ...(params.end === undefined ? {} : { end: params.end }),
      ...(accountIds === undefined ? {} : { accountIds }),
    });
    const transactions: NormalizedTransactionGroup[] = [];
    const seenIds = new Set<string>();
    let truncated = false;
    let total: number | null = 0;
    let executedQueries = 0;

    for (let index = 0; index < compiled.queries.length; index += 1) {
      const query = compiled.queries[index];
      if (query === undefined) continue;
      const result = await this.searchPreviewQuery(query, maxResults, signal);
      executedQueries += 1;
      if (compiled.strict) total = result.total;
      else total = null;
      for (const transaction of result.transactions) {
        if (seenIds.has(transaction.id)) continue;
        seenIds.add(transaction.id);
        if (transactions.length < maxResults) transactions.push(transaction);
        else truncated = true;
      }
      if (result.truncated) truncated = true;
      if (compiled.triggerStopProcessing[index] && result.transactions.length > 0) break;
      if (transactions.length >= maxResults && index < compiled.queries.length - 1) {
        truncated = true;
        break;
      }
    }

    return {
      ruleId: rule.id,
      strict: compiled.strict,
      queries: compiled.queries,
      executedQueries,
      previewEngine: "firefly-search",
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
      const currentPage = result.pagination.currentPage;
      const totalPages = result.pagination.totalPages;
      const hasAnotherPage = totalPages === null
        ? result.transactions.length >= limit
        : currentPage < totalPages;
      if (!hasAnotherPage || result.transactions.length === 0) break;
      if (transactions.length >= maxResults) {
        truncated = true;
        break;
      }
      page = currentPage + 1;
    }
    if (total !== null && total > transactions.length) truncated = true;
    return { transactions, total, truncated };
  }

  async createPendingRule(input: CreatePendingRuleInput, signal?: AbortSignal): Promise<NormalizedRule> {
    validateRuleTitle(input.title); resourceId(input.ruleGroupId); assertAllowedTriggers(input.triggers); assertAllowedActions(input.actions);
    await this.assertCategoriesExist(input.actions, signal);
    const semantic = proposedRule(input);
    const provisional = createPendingDescription(input.description, proposalDigest(semantic, input.description?.trim() ?? ""));
    let rule = normalizeRuleSingle(await this.client.post<unknown>("/rules", snapshot(semantic, false, provisional), withSignal(signal)));
    try {
      if (rule.active) rule = normalizeRuleSingle(await this.client.put<unknown>(`/rules/${resourceId(rule.id)}`, { active: false, description: rule.description ?? "" }, withSignal(signal)));
      return await this.resignPendingRule(rule, signal);
    } catch (error) {
      // Keep failed creations inactive. Deletion remains subject to the explicit
      // best-effort deletion policy because Firefly has no conditional DELETE.
      await this.cleanupFailedCreation(rule);
      throw error;
    }
  }

  async updatePendingRule(input: UpdatePendingRuleInput, signal?: AbortSignal): Promise<NormalizedRule> {
    const id = resourceId(input.id);
    if (input.ruleGroupId !== undefined) resourceId(input.ruleGroupId);
    return withRuleLock(id, async () => {
      const existing = await this.getRule(id, signal); const marker = assertPendingRule(existing);
      assertAllowedActions(existing.actions); if (input.title !== undefined) validateRuleTitle(input.title);
      if (input.triggers !== undefined) assertAllowedTriggers(input.triggers); if (input.actions !== undefined) assertAllowedActions(input.actions);
      const effectiveActions = input.actions ?? existing.actions.map((a) => ({ type: a.type as "set_category", value: a.value ?? "" }));
      assertAllowedActions(effectiveActions); await this.assertCategoriesExist(effectiveActions, signal);
      const candidate = mergeProposal(existing, input);
      const description = updatePendingDescription(marker, proposalDigest(candidate, input.description === undefined ? marker.userDescription : input.description.trim()), input.description);
      const response = normalizeRuleSingle(await this.client.put<unknown>(`/rules/${id}`, snapshot(candidate, false, description), withSignal(signal)));
      return this.resignPendingRule(response, signal);
    });
  }

  async confirmPendingRule(rawId: string, expectedProposalDigest: string, signal?: AbortSignal): Promise<NormalizedRule> {
    const id = resourceId(rawId);
    return withRuleLock(id, async () => {
      const existing = await this.getRule(id, signal); const marker = assertPendingRule(existing);
      if (marker.proposalDigest !== expectedProposalDigest) throw new FireflyError("FIREFLY_RULE_NOT_PENDING", "The reviewed proposal digest no longer matches this rule.");
      assertAllowedActions(existing.actions); assertAllowedTriggers(existing.triggers);
      await this.assertCategoriesExist(existing.actions.map((a) => ({ type: a.type as "set_category", value: a.value ?? "" })), signal);
      const inactive = normalizeRuleSingle(await this.client.put<unknown>(`/rules/${id}`, snapshot(existing, false, existing.description ?? ""), withSignal(signal)));
      const verifiedMarker = assertPendingRule(inactive);
      if (verifiedMarker.proposalDigest !== expectedProposalDigest) throw new FireflyError("FIREFLY_RULE_NOT_PENDING", "Firefly did not preserve the reviewed proposal.");
      const confirmedDescription = createConfirmedDescription(verifiedMarker);
      try {
        const rule = normalizeRuleSingle(
          await this.client.put<unknown>(
            `/rules/${id}`,
            { active: true, description: confirmedDescription },
            withSignal(signal),
          ),
        );
        if (
          !rule.active ||
          rule.description !== confirmedDescription ||
          parsePendingDescription(rule.description) !== null ||
          proposalDigest(rule, verifiedMarker.userDescription) !== expectedProposalDigest
        ) {
          throw new FireflyError(
            "FIREFLY_INVALID_RESPONSE",
            "Firefly did not activate the exact reviewed pending rule.",
          );
        }
        return rule;
      } catch (error) {
        const recovered = await this.restorePendingAfterActivationFailure(
          id,
          inactive,
          verifiedMarker,
          confirmedDescription,
        );
        if (!recovered) {
          throw new FireflyError(
            "FIREFLY_ACTIVATION_UNCERTAIN",
            "Firefly activation could not be verified or safely rolled back; inspect the rule before continuing.",
            undefined,
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  async rejectPendingRule(rawId: string, signal?: AbortSignal): Promise<{ id: string; rejected: true }> {
    const id = resourceId(rawId);
    if (!this.allowBestEffortPendingRuleDeletion) throw new FireflyError("FIREFLY_RULE_UNSAFE", "Pending-rule deletion is disabled: Firefly has no conditional DELETE. Enable it only with no external rule writers.");
    return withRuleLock(id, async () => { assertPendingRule(await this.getRule(id, signal)); await this.client.delete(`/rules/${id}`, withSignal(signal)); return { id, rejected: true }; });
  }

  private async cleanupFailedCreation(rule: NormalizedRule, signal?: AbortSignal): Promise<void> {
    const id = resourceId(rule.id);
    const createdMarker = parsePendingDescription(rule.description);
    if (createdMarker === null) return;
    await withRuleLock(id, async () => {
      try {
        let current = await this.getRule(id, signal);
        const marker = parsePendingDescription(current.description);
        if (marker?.proposalId !== createdMarker.proposalId) return;
        if (current.active) {
          current = normalizeRuleSingle(
            await this.client.put<unknown>(
              `/rules/${id}`,
              { active: false, description: current.description ?? "" },
              withSignal(signal),
            ),
          );
        }
        const inactiveMarker = parsePendingDescription(current.description);
        if (
          this.allowBestEffortPendingRuleDeletion &&
          !current.active &&
          inactiveMarker?.proposalId === createdMarker.proposalId
        ) {
          await this.client.delete(`/rules/${id}`, withSignal(signal));
        }
      } catch {
        // Preserve the original creation error. The rule may require operator inspection.
      }
    });
  }

  private async restorePendingAfterActivationFailure(
    id: string,
    inactive: NormalizedRule,
    marker: ReturnType<typeof assertPendingRule>,
    confirmedDescription: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const current = await this.getRule(id, signal);
      const currentPendingMarker = parsePendingDescription(current.description);
      const stillOwned = current.description === confirmedDescription || (
        currentPendingMarker?.proposalId === marker.proposalId &&
        currentPendingMarker.proposalDigest === marker.proposalDigest
      );
      if (!stillOwned) return false;
      const restored = normalizeRuleSingle(
        await this.client.put<unknown>(
          `/rules/${id}`,
          snapshot(inactive, false, inactive.description ?? ""),
          withSignal(signal),
        ),
      );
      const restoredMarker = assertPendingRule(restored);
      return restoredMarker.proposalId === marker.proposalId &&
        restoredMarker.proposalDigest === marker.proposalDigest;
    } catch (error) {
      if (error instanceof FireflyError && error.code === "FIREFLY_NOT_FOUND") return true;
      return false;
    }
  }

  private async resignPendingRule(rule: NormalizedRule, signal?: AbortSignal): Promise<NormalizedRule> {
    // A description-only PUT can itself cause Firefly to reset order. Re-read its
    // semantics and converge on the response, never on assumptions about its mutators.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const marker = parsePendingDescription(rule.description);
      if (marker === null || rule.active) throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly did not return an inactive pending-rule description.");
      const description = updatePendingDescription(marker, proposalDigest(rule, marker.userDescription));
      if (rule.description === description) {
        assertPendingRule(rule); assertAllowedActions(rule.actions); assertAllowedTriggers(rule.triggers);
        return rule;
      }
      rule = normalizeRuleSingle(await this.client.put<unknown>(`/rules/${resourceId(rule.id)}`, { active: false, description }, withSignal(signal)));
    }
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly did not stabilize the inactive proposal semantics while re-signing it.");
  }
  private async assertCategoriesExist(actions: readonly { type: string; value: string | null }[], signal?: AbortSignal): Promise<void> {
    const requested = new Set(actions.map((a) => a.value).filter((v): v is string => Boolean(v)));
    const existing = new Set((await this.listCategories({ page: 1, limit: 65_536 }, signal)).categories.map((c) => c.name));
    const missing = [...requested].filter((name) => !existing.has(name));
    if (missing.length) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Category ${JSON.stringify(missing[0])} does not exist in Firefly.`);
  }
}
function proposedRule(input: CreatePendingRuleInput): Omit<NormalizedRule, "id" | "description" | "ruleGroupTitle" | "createdAt" | "updatedAt" | "pending" | "pendingExpiresAt" | "proposalDigest"> { return { title: input.title, ruleGroupId: resourceId(input.ruleGroupId), order: input.order ?? 1, trigger: input.trigger ?? "store-journal", active: false, strict: input.strict ?? true, stopProcessing: input.stopProcessing ?? false, triggers: input.triggers.map((x, i) => ({ type: x.type, value: x.value, prohibited: x.prohibited ?? false, active: true, stopProcessing: false, order: i + 1 })), actions: input.actions.map((x, i) => ({ type: x.type, value: x.value, active: true, stopProcessing: false, order: i + 1 })) }; }
function mergeProposal(existing: NormalizedRule, input: UpdatePendingRuleInput): NormalizedRule { return { ...existing, title: input.title ?? existing.title, ruleGroupId: input.ruleGroupId === undefined ? existing.ruleGroupId : resourceId(input.ruleGroupId), order: input.order ?? existing.order, trigger: input.trigger ?? existing.trigger, strict: input.strict ?? existing.strict, stopProcessing: input.stopProcessing ?? existing.stopProcessing, triggers: input.triggers?.map((x, i) => ({ type: x.type, value: x.value, prohibited: x.prohibited ?? false, active: true, stopProcessing: false, order: i + 1 })) ?? existing.triggers, actions: input.actions?.map((x, i) => ({ type: x.type, value: x.value, active: true, stopProcessing: false, order: i + 1 })) ?? existing.actions }; }
function snapshot(rule: Pick<NormalizedRule, "title" | "ruleGroupId" | "order" | "trigger" | "strict" | "stopProcessing" | "triggers" | "actions">, active: boolean, description: string): Record<string, unknown> { return { title: rule.title, description, rule_group_id: resourceId(rule.ruleGroupId), order: rule.order ?? 1, trigger: rule.trigger, active, strict: rule.strict, stop_processing: rule.stopProcessing, triggers: rule.triggers.map((x, i) => ({ type: x.type, value: x.value, prohibited: x.prohibited, order: x.order ?? i + 1, active: x.active, stop_processing: x.stopProcessing })), actions: rule.actions.map((x, i) => ({ type: x.type, value: x.value, order: x.order ?? i + 1, active: x.active, stop_processing: x.stopProcessing })) }; }
function withSignal(signal: AbortSignal | undefined): { signal: AbortSignal } | Record<string, never> { return signal === undefined ? {} : { signal }; }
function resourceId(id: string): string { if (!/^[1-9]\d*$/u.test(id)) throw new FireflyError("FIREFLY_VALIDATION_FAILED", "Firefly resource IDs must be non-zero canonical numeric strings without leading zeroes."); return encodeURIComponent(id); }
function validateDateOnly(value: string, field: "start" | "end"): void { if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must use YYYY-MM-DD format.`); }
function validateRuleTitle(title: string): void { if (title.trim() === "" || title.length > 100) throw new FireflyError("FIREFLY_RULE_UNSAFE", "Rule title must contain 1 to 100 characters."); }
