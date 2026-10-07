# openclaw-firefly

A security-constrained OpenClaw plugin for reading Firefly III data, targeted transaction updates, and managing marked Firefly rules.

## Targeted transaction updates

`firefly_transaction_update` writes to exactly one transaction **group ID** (the ID returned by `firefly_transaction_get`, not its journal ID):

```json
{"transactionId":"123","type":"transfer","sourceAccountId":"10","destinationAccountId":"20"}
```

```json
{"transactionId":"456","addTags":["toDelete"]}
```

Direct categorization uses `{"transactionId":"123","categoryId":"14","counterpartyAccountId":"425"}`. Both new fields are optional canonical IDs. Category IDs must exist; an explicitly supplied category replaces the current category. Counterparty IDs must identify an active expense account for a withdrawal or revenue account for a deposit; the bank/card side is preserved. Transfers and special types do not support counterparty edits. Category clearing is not exposed.

Conversion requires `type: "transfer"` and both distinct account IDs together. `addTags` trims incoming tag names and appends them without removing existing tags; whitespace-only names are rejected before any request. Tag order does not affect verification. Category and tag edits may accompany either operation; counterparty edits cannot accompany transfer conversion. At least one change is required. There is no `dryRun` argument: calls write immediately. Already-satisfied updates return `changed: false` without a PUT.

The tool reads the transaction, rejects splits, sends only the journal ID and requested fields through `PUT /transactions/{id}`, with `apply_rules: false` and `fire_webhooks: false`, then reads it back. Successful results contain `changed`, `verified: true`, and the normalized transaction. Conversion supports withdrawals, deposits, and existing transfers. Budget-linked conversions (and budget-linked existing transfers) are rejected because Firefly removes budgets from transfers. Other metadata is omitted from the update; core accounting fields and associations are checked on readback.

No transaction deletion or automatic matching is exposed. A `toDelete` tag is only a review marker; it does not remove the duplicate's accounting effect. A matching workflow must verify the retained transfer before tagging its counterpart.

Updates are not atomic with the initial read or verification. Avoid concurrent edits to the same transaction: Firefly provides no compare-and-swap here, so concurrent tag changes may be overwritten. A failed/uncertain write or readback is never automatically retried; inspect the transaction before continuing. This tool does not promise rollback or deduplication across imports.

API contract: [TransactionUpdate](https://github.com/firefly-iii/api-docs/blob/main/src/v1/schemas/models/TransactionGroup/TransactionUpdate.yaml) and [TransactionSplitUpdate](https://github.com/firefly-iii/api-docs/blob/main/src/v1/schemas/models/TransactionSplit/TransactionSplitUpdate.yaml). Budget behaviour was source-reviewed against Firefly III v6.7.2.

## Managed-rule workflow

A plugin-created rule is always inactive and starts with this description marker:

```text
[openclaw-firefly:managed:v1]
Optional human-readable description
```

The marker identifies a managed rule; it is not a signature or authentication boundary. Firefly's stored rule is the source of truth. Reads report `managed` and `active`.

1. Read existing rules and transactions, then create or inspect a managed rule.
2. Run `firefly_rule_test` on the persisted rule and review its examples, count only when supplied, truncation, and scope.
3. Use `firefly_rule_activate` with `confirmed: true` only after explicit approval. Activation enables future rule processing; it **never** runs history.
4. To edit an active rule, first call `firefly_rule_deactivate` with `confirmed: true`, verify its inactive readback, then update and preview it again. Updating and deleting require an inactive managed rule.
5. Use `firefly_rule_execute` only with separate explicit approval. It runs once against **all accounts and all dates** on the supported backend; a filtered preview does not narrow that scope.

`confirmed: true` records the tool invocation's confirmation step. It does not prove that a person approved it. The agent workflow must obtain and retain the human approval.

When updating, omitted scalar fields are preserved. A supplied `triggers` or `actions` value replaces that entire array: read the current array and copy every entry, including trigger `prohibited` and per-entry `active` and `stopProcessing` flags, before changing one entry. New entries default to active and not-stop-processing. Re-preview after every edit.

Sequence operations on one rule and dependent work (for example, deactivate → update → preview → activate). Different, independent rules do not need blanket serialization.

## Safety boundaries

- Only managed rules can be updated, activated, deactivated, deleted, or historically executed through these rule tools.
- Deletion requires `confirmed: true` and an inactive rule. Activation, deactivation, and execution also require `confirmed: true`.
- Rule triggers and actions are allowlisted. Referenced categories, active budgets, tags, and active accounts must already exist.
- Transaction writes are restricted to the targeted conversion/tagging tool above; transaction deletion is not exposed. The plugin exposes no arbitrary URL/header/HTTP tool, generic rule mutation, or arbitrary trigger endpoint.
- Historical execution is always all-accounts/all-dates; there is no backend version gate. Preview is search-based and may be truncated or unable to provide an exact total.
- A timeout, network failure, 5xx, cancellation, or failed mutation readback can leave the outcome uncertain. Inspect Firefly before retrying; do not assume no change occurred.

## Requirements

- Node.js 24.16+ or 26.1+
- OpenClaw >= 2026.5.17
- Firefly III with the rule trigger API for historical execution
- A current Firefly Personal Access Token

## Build and test

```sh
npm install
npm run build
npm test
npm run check # requires Node 24.16+ or 26.1+
```

On Node 24.13.0, `plugin:validate` is blocked by OpenClaw's `node:sqlite` embedded-NUL issue. Use Node 24.16+ or 26.1+; that limitation does not indicate that the plugin is invalid.

For a path-installed checkout, rebuild the generated `dist/` output and restart the Gateway after every source update:

```sh
git pull --ff-only
npm ci
npm run build
openclaw gateway restart
```

Then make a read-only tool call before resuming mutations.

## Configuration

Use OpenClaw SecretRefs for credentials:

```json5
{
  plugins: {
    entries: {
      "openclaw-firefly": {
        enabled: true,
        config: {
          baseUrl: "https://firefly.example.com",
          accessToken: { source: "env", provider: "default", id: "FIREFLY_ACCESS_TOKEN" },
          headers: {
            "CF-Access-Client-Id": { source: "env", provider: "default", id: "FIREFLY_CF_CLIENT_ID" }
          },
          requestTimeoutMs: 10000,
          maxResponseBytes: 5242880
        }
      }
    }
  }
}
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for fields and upgrade steps, and [docs/SECURITY.md](docs/SECURITY.md) for security details.

## Tools

Read-only: `firefly_transactions_list`, `firefly_transaction_get`, `firefly_transactions_search`, `firefly_categories_list`, `firefly_budgets_list`, `firefly_tags_list`, `firefly_accounts_list`, `firefly_rules_list`, `firefly_rule_get`, `firefly_rule_groups_list`, and `firefly_rule_test`.

Direct constrained creation: `firefly_expense_account_create`, `firefly_revenue_account_create`, `firefly_category_create`, and `firefly_tag_create`.

Managed-rule tools: `firefly_rule_create`, `firefly_rule_update`, `firefly_rule_activate`, `firefly_rule_deactivate`, `firefly_rule_delete`, and `firefly_rule_execute`.

## Legacy managed rules

Rules whose first description line is a recognized legacy `pending:v1` or `confirmed:v1` OpenClaw marker remain managed. Old UUID, digest, and expiry metadata are not validated. The next requested update, activation, or state-changing write normalizes the marker to `managed:v1`; reads, previews, execution, and state-toggle no-ops do not write merely to migrate it.

## Compatibility

The plugin's API behavior is documented in [docs/API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md).

Account creation fixes the account type to expense or revenue, respectively. Rule account targets are resolved within compatible account types when a strict, positive transaction-type guard proves the context. Cross-type expense/revenue names are supported; ambiguous compatible targets remain rejected. OR rules and conversion chains retain conservative name validation.

Single-transaction budget assignment uses {"transactionId":"123","budgetId":"5"}. The budget must exist and be active; only withdrawals are supported. This can accompany category/payee edits, but not transfer conversion. Omitted budgets are preserved; clearing is not exposed. Transaction reads include budgetId and budgetName.
