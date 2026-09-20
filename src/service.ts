import { createHash } from "node:crypto";
import type { FireflyClient } from "./client.js";
import { FireflyError } from "./errors.js";
import {
  assertAllowedActions, assertAllowedTriggers, assertExecutionRule, assertPendingRule, createConfirmedDescription,
  createPendingDescription, parsePendingDescription, proposalDigest, updatePendingDescription,
} from "./rule-safety.js";
import { compileRulePreview } from "./rule-preview.js";
import { normalizeAccountCollection } from "./schemas/accounts.js";
import { normalizeCreatedCategory, normalizeCreatedExpenseAccount, normalizeCreatedTag } from "./schemas/created.js";
import { normalizeBudgetCollection, normalizeTagCollection } from "./schemas/metadata.js";
import { normalizeCategoryCollection, normalizeRuleCollection, normalizeRuleGroupCollection, normalizeRuleSingle, type NormalizedRule, type RuleActionInput, type RuleMoment, type RuleTriggerInput } from "./schemas/rules.js";
import { normalizeTransactionCollection, normalizeTransactionSingle, type NormalizedTransactionGroup, type TransactionPage } from "./schemas/transactions.js";

export interface PageParams { page?: number; limit?: number; }
export interface TransactionListParams extends PageParams { start?: string; end?: string; type?: string; }
export interface TransactionSearchParams extends PageParams { query: string; }
export interface CategoryListParams extends PageParams { start?: string; end?: string; }
export interface BudgetListParams extends PageParams { start?: string; end?: string; }
export interface RuleTestParams { id: string; start?: string; end?: string; accountIds?: string[]; maxResults?: number; }
export interface RulePreviewResult extends TransactionPage {
  ruleId: string;
  strict: boolean;
  queries: string[];
  executedQueries: number;
  previewEngine: "firefly-search";
  previewReceipt: string;
  executionScope: "all-accounts-all-dates" | "limited-preview-only";
  executionBackend: "firefly-v6.7.2-rule-trigger";
  truncated: boolean;
}

interface PreviewReceipt { ruleId: string; ruleDigest: string; scope: "all-accounts-all-dates" | "limited-preview-only"; backendIdentity: string; used: boolean; expiresAt: number; }
const previewReceipts = new Map<string, PreviewReceipt>();
const PREVIEW_RECEIPT_TTL_MS = 15 * 60 * 1_000;
export interface CreatePendingRuleInput { title: string; description?: string; ruleGroupId: string; trigger?: RuleMoment; strict?: boolean; stopProcessing?: boolean; order?: number; triggers: RuleTriggerInput[]; actions: RuleActionInput[]; }
export interface UpdatePendingRuleInput { id: string; title?: string; description?: string; ruleGroupId?: string; trigger?: RuleMoment; strict?: boolean; stopProcessing?: boolean; order?: number; triggers?: RuleTriggerInput[]; actions?: RuleActionInput[]; }

// Shared by all service instances in this Gateway process. Firefly v6.7.2 offers no CAS.
const ruleLocks = new Map<string, Promise<void>>();
const groupLocks = new Map<string, Promise<void>>();
async function withLock<T>(locks: Map<string, Promise<void>>, id: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(id, current);
  await previous;
  try { return await operation(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
}
function withRuleLock<T>(id: string, operation: () => Promise<T>): Promise<T> { return withLock(ruleLocks, id, operation); }
function withGroupLock<T>(id: string, operation: () => Promise<T>): Promise<T> { return withLock(groupLocks, id, operation); }

export class FireflyService {
  constructor(private readonly client: FireflyClient, private readonly allowBestEffortPendingRuleDeletion = false) {}

  async createExpenseAccount(input: { name: string; notes?: string }, signal?: AbortSignal) {
    validateCreationText(input.name, "name", 1024);
    if (input.notes !== undefined) validateOptionalText(input.notes, "notes", 32_000);
    return this.createWithUncertainOutcome(() => this.client.post<unknown>("/accounts", { name: input.name, type: "expense", ...(input.notes === undefined ? {} : { notes: input.notes }) }, withSignal(signal)).then(normalizeCreatedExpenseAccount));
  }
  async createCategory(input: { name: string; notes?: string }, signal?: AbortSignal) {
    validateCreationText(input.name, "name", 100);
    if (input.notes !== undefined) validateOptionalText(input.notes, "notes", 32_000);
    return this.createWithUncertainOutcome(() => this.client.post<unknown>("/categories", { name: input.name, ...(input.notes === undefined ? {} : { notes: input.notes }) }, withSignal(signal)).then(normalizeCreatedCategory));
  }
  async createTag(input: { name: string; description?: string }, signal?: AbortSignal) {
    validateCreationText(input.name, "name", 1024);
    if (input.description !== undefined) validateOptionalText(input.description, "description", 32_000);
    return this.createWithUncertainOutcome(() => this.client.post<unknown>("/tags", { tag: input.name, ...(input.description === undefined ? {} : { description: input.description }) }, withSignal(signal)).then(normalizeCreatedTag));
  }
  async listTransactions(params: TransactionListParams, signal?: AbortSignal) { return normalizeTransactionCollection(await this.client.get<unknown>("/transactions", { query: { page: params.page, limit: params.limit, start: params.start, end: params.end, type: params.type }, ...withSignal(signal) })); }
  async getTransaction(id: string, signal?: AbortSignal) { return normalizeTransactionSingle(await this.client.get<unknown>(`/transactions/${resourceId(id)}`, withSignal(signal))); }
  async searchTransactions(params: TransactionSearchParams, signal?: AbortSignal) { return normalizeTransactionCollection(await this.client.get<unknown>("/search/transactions", { query: { query: params.query, page: params.page, limit: params.limit }, ...withSignal(signal) })); }
  async listCategories(params: CategoryListParams, signal?: AbortSignal) { return normalizeCategoryCollection(await this.client.get<unknown>("/categories", { query: { page: params.page, limit: params.limit, start: params.start, end: params.end }, ...withSignal(signal) })); }
  async listBudgets(params: BudgetListParams, signal?: AbortSignal) { return normalizeBudgetCollection(await this.client.get<unknown>("/budgets", { query: { page: params.page, limit: params.limit, start: params.start, end: params.end }, ...withSignal(signal) })); }
  async listTags(params: PageParams, signal?: AbortSignal) { return normalizeTagCollection(await this.client.get<unknown>("/tags", { query: { page: params.page, limit: params.limit }, ...withSignal(signal) })); }
  async listAccounts(params: PageParams, signal?: AbortSignal) { return normalizeAccountCollection(await this.client.get<unknown>("/accounts", { query: { type: "all", page: params.page, limit: params.limit }, ...withSignal(signal) })); }
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
    const backendIdentity = await this.verifiedBackendIdentity(signal);
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

    // Firefly's trigger endpoint has no bounded dry-run. A filtered search is
    // useful for inspection but cannot authorize the fixed full-history backfill.
    const executionScope = params.start === undefined && params.end === undefined && params.accountIds === undefined
      ? "all-accounts-all-dates" as const
      : "limited-preview-only" as const;
    const previewReceipt = rememberPreview(rule, executionScope, backendIdentity);
    return {
      ruleId: rule.id,
      strict: compiled.strict,
      queries: compiled.queries,
      executedQueries,
      previewEngine: "firefly-search",
      previewReceipt,
      executionScope,
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

  private async createWithUncertainOutcome<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof FireflyError && ["FIREFLY_TIMEOUT", "FIREFLY_NETWORK_ERROR", "FIREFLY_CANCELLED", "FIREFLY_TEMPORARY_FAILURE", "FIREFLY_INVALID_RESPONSE"].includes(error.code)) {
        throw new FireflyError("FIREFLY_CREATION_UNCERTAIN", "Creation may have succeeded but could not be verified. Inspect Firefly before attempting another creation.", undefined, { cause: error });
      }
      throw error;
    }
  }
  private async verifiedBackendIdentity(signal?: AbortSignal): Promise<string> {
    const about = await this.client.get<unknown>("/about", withSignal(signal));
    const version = about !== null && typeof about === "object" && "data" in about
      && about.data !== null && typeof about.data === "object" && "version" in about.data
      ? about.data.version : undefined;
    if (typeof version !== "string" || version.trim() === "") {
      throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly returned an invalid /about response.");
    }
    if (version !== "6.7.2") throw new FireflyError("FIREFLY_RULE_UNSAFE", "Historical execution is supported only on a verified Firefly III v6.7.2 backend.");
    const headers = new Headers({ Accept: "application/vnd.api+json, application/json", Authorization: `Bearer ${this.client.config.accessToken}` });
    for (const [name, value] of Object.entries(this.client.config.headers)) headers.set(name, value);
    const effectiveHeaders = [...headers.entries()].sort(([left], [right]) => left.localeCompare(right));
    return createHash("sha256").update(JSON.stringify({ baseUrl: this.client.config.baseUrl.toString(), accessToken: this.client.config.accessToken, effectiveHeaders })).digest("hex");
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

  async executeRule(rawId: string, expectedPreviewReceipt: string, confirmed: true, signal?: AbortSignal): Promise<{ id: string; executed: true; executionScope: "all-accounts-all-dates" }> {
    const id = resourceId(rawId);
    if (confirmed !== true) throw new FireflyError("FIREFLY_VALIDATION_FAILED", "confirmed must be true.");
    return withRuleLock(id, async () => {
      const backendIdentity = await this.verifiedBackendIdentity(signal);
      const receipt = previewReceipts.get(expectedPreviewReceipt);
      if (receipt !== undefined && receipt.ruleId === id && receipt.scope === "limited-preview-only") {
        throw new FireflyError("FIREFLY_RULE_PREVIEW_SCOPE_LIMITED", "A filtered preview cannot authorize historical execution. Preview this rule again without date or account filters.");
      }
      if (receipt === undefined || receipt.used || receipt.expiresAt < Date.now() || receipt.ruleId !== id || receipt.scope !== "all-accounts-all-dates" || receipt.backendIdentity !== backendIdentity) {
        throw new FireflyError("FIREFLY_RULE_PREVIEW_REQUIRED", "A current preview receipt for this rule and the all-accounts/all-dates scope is required. Preview the rule again.");
      }
      const rule = await this.getRule(id, signal);
      if (ruleSemanticDigest(rule) !== receipt.ruleDigest) {
        throw new FireflyError("FIREFLY_RULE_PREVIEW_STALE", "The rule changed after it was previewed. Preview the current rule again before historical execution.");
      }
      assertExecutionRule(rule); assertAllowedTriggers(rule.triggers); assertAllowedActions(rule.actions);
      await this.assertActionTargetsExist(rule.actions, signal);
      // Consume before the request. A timeout or broken connection may still have
      // started Firefly's synchronous backfill, so this receipt can never replay it.
      receipt.used = true;
      try {
        const response = await this.client.post<unknown>(`/rules/${id}/trigger`, { accounts: [] }, withSignal(signal));
        if (response !== undefined) throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly did not return the required empty 204 response for historical execution.");
      } catch (error) {
        if (error instanceof FireflyError && ["FIREFLY_TIMEOUT", "FIREFLY_NETWORK_ERROR", "FIREFLY_CANCELLED", "FIREFLY_TEMPORARY_FAILURE", "FIREFLY_INVALID_RESPONSE"].includes(error.code)) {
          throw new FireflyError("FIREFLY_RULE_EXECUTION_UNCERTAIN", "Historical rule execution may have started but could not be confirmed. Inspect Firefly before attempting another execution.", undefined, { cause: error });
        }
        throw error;
      }
      return { id, executed: true, executionScope: "all-accounts-all-dates" };
    });
  }

  async createPendingRule(input: CreatePendingRuleInput, signal?: AbortSignal): Promise<NormalizedRule> {
    validateRuleTitle(input.title); resourceId(input.ruleGroupId); assertAllowedTriggers(input.triggers); assertAllowedActions(input.actions);
    await this.assertActionTargetsExist(input.actions, signal);
    return withGroupLock(resourceId(input.ruleGroupId), async () => {
      const order = input.order ?? await this.nextRuleOrder(resourceId(input.ruleGroupId), signal);
      const semantic = proposedRule({ ...input, order });
      const provisional = createPendingDescription(input.description, proposalDigest(semantic, input.description?.trim() ?? ""));
      let rule = normalizeRuleSingle(await this.client.post<unknown>("/rules", snapshot(semantic, false, provisional), withSignal(signal)));
      try {
        if (rule.active) rule = normalizeRuleSingle(await this.client.put<unknown>(`/rules/${resourceId(rule.id)}`, { active: false, description: rule.description ?? "" }, withSignal(signal)));
        return await this.resignPendingRule(rule, signal);
      } catch (error) {
        // Keep failed creations inactive. Deletion remains subject to the explicit
        // best-effort deletion policy because Firefly has no conditional DELETE.
        await this.cleanupFailedCreation(rule);
        const code = error instanceof FireflyError ? error.code : "FIREFLY_INVALID_RESPONSE";
        throw new FireflyError(code, `Pending rule ${rule.id} creation failed; inspect that rule before retrying.`, undefined, { cause: error });
      }
    });
  }

  async updatePendingRule(input: UpdatePendingRuleInput, signal?: AbortSignal): Promise<NormalizedRule> {
    const id = resourceId(input.id);
    if (input.ruleGroupId !== undefined) resourceId(input.ruleGroupId);
    return withRuleLock(id, async () => {
      const existing = await this.getRule(id, signal); const marker = assertPendingRule(existing);
      assertAllowedActions(existing.actions); if (input.title !== undefined) validateRuleTitle(input.title);
      if (input.triggers !== undefined) assertAllowedTriggers(input.triggers); if (input.actions !== undefined) assertAllowedActions(input.actions);
      const effectiveActions = input.actions ?? existing.actions;
      assertAllowedActions(effectiveActions); await this.assertActionTargetsExist(effectiveActions, signal);
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
      await this.assertActionTargetsExist(existing.actions, signal);
      // The initial GET is the reviewed integrity check. Do not rewrite its full
      // snapshot: Firefly replaces visible triggers on such PUTs.
      const confirmedDescription = createConfirmedDescription(marker);
      try {
        await this.client.put<unknown>(
          `/rules/${id}`,
          { active: true, description: confirmedDescription },
          withSignal(signal),
        );
        // PUT responses are not authoritative for Firefly's group-wide
        // normalization. Verify the persisted resource instead.
        const rule = await this.getRule(id, signal);
        if (
          !rule.active ||
          rule.description !== confirmedDescription ||
          proposalDigest(rule, marker.userDescription) !== expectedProposalDigest
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
          existing,
          marker,
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

  private async cleanupFailedCreation(rule: NormalizedRule): Promise<void> {
    const id = resourceId(rule.id);
    const createdMarker = parsePendingDescription(rule.description);
    if (createdMarker === null) return;
    await withRuleLock(id, async () => {
      try {
        let current = await this.getRule(id);
        const marker = parsePendingDescription(current.description);
        if (marker?.proposalId !== createdMarker.proposalId) return;
        if (current.active) {
          current = normalizeRuleSingle(
            await this.client.put<unknown>(
              `/rules/${id}`,
              { active: false, description: current.description ?? "" },
              undefined,
            ),
          );
        }
        const inactiveMarker = parsePendingDescription(current.description);
        if (
          this.allowBestEffortPendingRuleDeletion &&
          !current.active &&
          inactiveMarker?.proposalId === createdMarker.proposalId
        ) {
          await this.client.delete(`/rules/${id}`);
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
      if (!current.active && currentPendingMarker?.proposalId === marker.proposalId && currentPendingMarker.proposalDigest === marker.proposalDigest) {
        // A matching marker alone is not proof of rollback: its semantics may
        // have changed while activation was in flight.
        assertPendingRule(current);
        return true;
      }
      // Only undo an activation we can still identify as ours. Do not restore a
      // full snapshot, which could overwrite concurrent semantic edits.
      if (!current.active || current.description !== confirmedDescription) return false;
      await this.client.put<unknown>(
        `/rules/${id}`,
        { active: false, description: inactive.description ?? "" },
        withSignal(signal),
      );
      const restored = await this.getRule(id, signal);
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
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const marker = parsePendingDescription(rule.description);
      if (marker === null || rule.active) throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly did not return an inactive pending-rule description.");
      const description = updatePendingDescription(marker, proposalDigest(rule, marker.userDescription));
      if (rule.description === description) {
        assertPendingRule(rule); assertAllowedActions(rule.actions); assertAllowedTriggers(rule.triggers);
        return rule;
      }
      if (attempt === 3) break;
      rule = normalizeRuleSingle(await this.client.put<unknown>(`/rules/${resourceId(rule.id)}`, { active: false, description }, withSignal(signal)));
    }
    throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly did not stabilize the inactive proposal semantics while re-signing it.");
  }
  private async nextRuleOrder(ruleGroupId: string, signal?: AbortSignal): Promise<number> {
    const limit = 100;
    let page = 1;
    let highest = 0;
    for (;;) {
      const result = await this.listRules({ page, limit }, signal);
      highest = result.rules
        .filter((rule) => rule.ruleGroupId === ruleGroupId)
        .reduce((max, rule) => Math.max(max, rule.order ?? 0), highest);
      const { totalPages } = result.pagination;
      // `currentPage` normalizes to 1 when Firefly omits it, so advance the
      // requested page rather than trusting the fallback value.
      if (totalPages !== null ? page >= totalPages : result.rules.length < limit) return highest + 1;
      page += 1;
    }
  }
  private async assertActionTargetsExist(actions: readonly { type: string; value: string | null }[], signal?: AbortSignal): Promise<void> {
    const categories = actions.filter((action) => action.type === "set_category").map((action) => action.value).filter((value): value is string => value !== null);
    if (categories.length > 0) {
      const existing = new Set((await this.listCategories({ page: 1, limit: 65_536 }, signal)).categories.map((category) => category.name));
      const missing = categories.find((name) => !existing.has(name));
      if (missing !== undefined) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Category ${JSON.stringify(missing)} does not exist in Firefly.`);
    }

    const budgets = actions.filter((action) => action.type === "set_budget").map((action) => action.value).filter((value): value is string => value !== null);
    if (budgets.length > 0) {
      const existing = new Set((await this.listBudgets({ page: 1, limit: 65_536 }, signal)).budgets.filter((budget) => budget.active).map((budget) => budget.name));
      const missing = budgets.find((name) => !existing.has(name));
      if (missing !== undefined) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Active budget ${JSON.stringify(missing)} does not exist in Firefly.`);
    }

    const tags = actions.filter((action) => action.type === "add_tag" || action.type === "remove_tag").map((action) => action.value).filter((value): value is string => value !== null);
    if (tags.length > 0) {
      const existing = new Set((await this.listTags({ page: 1, limit: 65_536 }, signal)).tags.map((tag) => tag.name));
      const missing = tags.find((name) => !existing.has(name));
      if (missing !== undefined) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Tag ${JSON.stringify(missing)} does not exist in Firefly.`);
    }

    const accountNames = actions.filter((action) => action.type === "set_source_account" || action.type === "set_destination_account" || action.type === "convert_transfer").map((action) => action.value).filter((value): value is string => value !== null);
    if (accountNames.length > 0) {
      const accounts = (await this.listAccounts({ page: 1, limit: 65_536 }, signal)).accounts.filter((account) => account.active);
      for (const name of accountNames) {
        const matches = accounts.filter((account) => account.name === name);
        if (matches.length === 0) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Active account ${JSON.stringify(name)} does not exist in Firefly.`);
        if (matches.length > 1) throw new FireflyError("FIREFLY_RULE_UNSAFE", `Account name ${JSON.stringify(name)} is ambiguous in Firefly.`);
      }
    }
  }
}
function proposedRule(input: CreatePendingRuleInput): Omit<NormalizedRule, "id" | "description" | "ruleGroupTitle" | "createdAt" | "updatedAt" | "pending" | "pendingExpiresAt" | "proposalDigest"> { return { title: input.title, ruleGroupId: resourceId(input.ruleGroupId), order: input.order ?? 1, trigger: input.trigger ?? "store-journal", active: false, strict: input.strict ?? true, stopProcessing: input.stopProcessing ?? false, triggers: input.triggers.map((x, i) => ({ type: x.type, value: x.value, prohibited: x.prohibited ?? false, active: true, stopProcessing: false, order: i + 1 })), actions: input.actions.map((x, i) => ({ type: x.type, value: x.value, active: true, stopProcessing: false, order: i + 1 })) }; }
function mergeProposal(existing: NormalizedRule, input: UpdatePendingRuleInput): NormalizedRule { return { ...existing, title: input.title ?? existing.title, ruleGroupId: input.ruleGroupId === undefined ? existing.ruleGroupId : resourceId(input.ruleGroupId), order: input.order ?? existing.order, trigger: input.trigger ?? existing.trigger, strict: input.strict ?? existing.strict, stopProcessing: input.stopProcessing ?? existing.stopProcessing, triggers: input.triggers?.map((x, i) => ({ type: x.type, value: x.value, prohibited: x.prohibited ?? false, active: true, stopProcessing: false, order: i + 1 })) ?? existing.triggers, actions: input.actions?.map((x, i) => ({ type: x.type, value: x.value, active: true, stopProcessing: false, order: i + 1 })) ?? existing.actions }; }
function snapshot(rule: Pick<NormalizedRule, "title" | "ruleGroupId" | "order" | "trigger" | "strict" | "stopProcessing" | "triggers" | "actions">, active: boolean, description: string): Record<string, unknown> { return { title: rule.title, description, rule_group_id: resourceId(rule.ruleGroupId), order: rule.order ?? 1, trigger: rule.trigger, active, strict: rule.strict, stop_processing: rule.stopProcessing, triggers: rule.triggers.map((x, i) => ({ type: x.type, value: x.value, prohibited: x.prohibited, order: x.order ?? i + 1, active: x.active, stop_processing: x.stopProcessing })), actions: rule.actions.map((x, i) => ({ type: x.type, value: x.value, order: x.order ?? i + 1, active: x.active, stop_processing: x.stopProcessing })) }; }
function withSignal(signal: AbortSignal | undefined): { signal: AbortSignal } | Record<string, never> { return signal === undefined ? {} : { signal }; }
function resourceId(id: string): string { if (!/^[1-9]\d*$/u.test(id)) throw new FireflyError("FIREFLY_VALIDATION_FAILED", "Firefly resource IDs must be non-zero canonical numeric strings without leading zeroes."); return encodeURIComponent(id); }
function validateDateOnly(value: string, field: "start" | "end"): void { if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must use YYYY-MM-DD format.`); }
function rememberPreview(rule: NormalizedRule, scope: "all-accounts-all-dates" | "limited-preview-only", backendIdentity: string): string {
  for (const [key, value] of previewReceipts) if (value.expiresAt < Date.now()) previewReceipts.delete(key);
  const ruleDigest = ruleSemanticDigest(rule);
  const receipt = createHash("sha256").update(JSON.stringify({ ruleId: rule.id, ruleDigest, scope, backendIdentity, at: Date.now() })).digest("hex");
  previewReceipts.set(receipt, { ruleId: rule.id, ruleDigest, scope, backendIdentity, used: false, expiresAt: Date.now() + PREVIEW_RECEIPT_TTL_MS });
  return receipt;
}
function ruleSemanticDigest(rule: NormalizedRule): string {
  return createHash("sha256").update(JSON.stringify({ title: rule.title, ruleGroupId: rule.ruleGroupId, order: rule.order, trigger: rule.trigger, active: rule.active, strict: rule.strict, stopProcessing: rule.stopProcessing, triggers: rule.triggers, actions: rule.actions })).digest("hex");
}
function validateCreationText(value: string, field: string, maxLength: number): void { if (value.trim() === "" || value.length > maxLength) throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must contain 1 to ${maxLength} characters.`); }
function validateOptionalText(value: string, field: string, maxLength: number): void { if (value.length > maxLength) throw new FireflyError("FIREFLY_VALIDATION_FAILED", `${field} must not exceed ${maxLength} characters.`); }
function validateRuleTitle(title: string): void { if (title.trim() === "" || title.length > 100) throw new FireflyError("FIREFLY_RULE_UNSAFE", "Rule title must contain 1 to 100 characters."); }
