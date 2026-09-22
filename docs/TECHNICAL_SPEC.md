# OpenClaw ↔ Firefly III integration
## Technical specification: managed rules

**Status:** Implemented contract

## Purpose

`openclaw-firefly` is a narrow OpenClaw tool plugin for a self-hosted Firefly III instance. Firefly remains the source of truth for transactions and rule semantics. The plugin supplies constrained reads, selected metadata creation, managed rule lifecycle tools, and a search-based rule preview.

The plugin does not include a categorizer skill, Telegram integration, scheduling, automatic cleanup, or a background migration job.

## Platform contract

- Node.js 24.16+ or 26.1+
- OpenClaw >= 2026.5.17
- Firefly III v6.7.2 for historical execution
- `baseUrl`, bearer token, and static proxy headers are operator configuration, not tool input

Use SecretRefs for the bearer token and secret headers. HTTPS is required unless the operator deliberately enables HTTP for a trusted local/test network.

## Managed-rule model

A plugin-created rule is inactive and has this first description line:

```text
[openclaw-firefly:managed:v1]
```

The rest of the description is human text. The plugin reports `managed` and Firefly's `active` state. The marker identifies the rule as managed; it does not authenticate it or freeze its contents. Firefly's current stored rule is authoritative.

Anchored first-line legacy markers are also managed:

- `[openclaw-firefly:pending:v1;...]`
- `[openclaw-firefly:confirmed:v1;...]`

Legacy proposal UUIDs, hashes, creation/expiry timestamps, and current-content digests are ignored. A requested update, activation, or state-changing deactivation normalizes a legacy marker to `managed:v1`. Reads, previews, execution, and no-op activation/deactivation do not write merely to migrate a marker. Rules without a recognized first-line marker are unmanaged.

## Tools

### Read-only

```text
firefly_transactions_list
firefly_transaction_get
firefly_transactions_search
firefly_categories_list
firefly_budgets_list
firefly_tags_list
firefly_accounts_list
firefly_rules_list
firefly_rule_get
firefly_rule_groups_list
firefly_rule_test
```

`firefly_rule_test` fetches the stored rule, translates supported triggers to Firefly search syntax, and returns examples, a count only when known, truncation, and scope. It does not mutate or execute history. Date/account filters make the preview `limited-preview-only`; they never constrain execution.

### Constrained creation

```text
firefly_expense_account_create
firefly_category_create
firefly_tag_create
```

These create only the stated minimal resource surface. Category, tag, account, budget, and rule-group general mutation is not exposed.

### Managed-rule lifecycle

```text
firefly_rule_create
firefly_rule_update
firefly_rule_activate
firefly_rule_deactivate
firefly_rule_delete
firefly_rule_execute
```

| Tool | Contract |
|---|---|
| create | Validates supported fields, adds the marker, forces inactive creation, then returns a GET readback. |
| update | Requires a managed inactive rule; preserves omitted fields and keeps it inactive. |
| activate | Requires a managed rule and `confirmed: true`; enables future configured processing only. It never executes history. Already-active is a no-op. |
| deactivate | Requires a managed rule and `confirmed: true`; disables it for editing. It never executes history. Already-inactive is a no-op. |
| delete | Requires a managed inactive rule and `confirmed: true`. |
| execute | Requires a managed active rule and `confirmed: true`; executes full history once on v6.7.2. |

Creation has no `confirmed` parameter. Activation, deactivation, deletion, and execution require `confirmed: true`. That value records an invocation confirmation step, not evidence that a human approved it.

## Agent workflow requirements

1. Inspect current rules and historical examples before proposing a deterministic rule.
2. Create it inactive, then preview the persisted rule and explain examples, counterexamples, count uncertainty, and truncation.
3. Obtain explicit approval before activation. State that activation affects future processing and does not execute historical transactions.
4. For an active rule, explicitly deactivate it and verify inactive readback before editing. Do not auto-deactivate or reactivate as part of update.
5. Updating a rule preserves omitted scalar fields. If `triggers` or `actions` is supplied, it replaces that entire array; first read the whole array and copy every untouched entry, including trigger `prohibited` and per-entry `active` and `stopProcessing` flags. New entries default to active and not-stop-processing. Re-preview and obtain review after an edit.
6. Obtain separate explicit approval before historical execution. State independently that it runs all accounts and all dates; previews, filters, example lists, and date ranges do not define its execution boundary.
7. Sequence operations on the same rule and dependent actions. Do not start dependent follow-up work after failure or uncertainty. Independent different-rule operations may proceed without blanket serialization.
8. Treat `confirmed: true` as an invocation value only. The conversation/workflow, not the plugin, supplies human approval.

## Rule safety policy

Allowed actions are `set_category`, `set_budget`, `add_tag`, `remove_tag`, `set_description`, `set_notes`, `set_source_account`, `set_destination_account`, and `convert_transfer`. Trigger types are restricted to the reviewed Firefly v6.7.2 subset. Unknown actions or triggers fail closed.

Before rule creation, update, and activation, referenced categories, active budgets, tags, and active accounts are checked by exact name. The plugin rejects duplicate singleton actions and a tag both added and removed by one rule. It does not expose transaction deletion, amount/currency changes, generic HTTP, generic rule deletion, or arbitrary trigger requests.

## History execution and uncertainty

Historical execution calls Firefly's v6.7.2 rule trigger endpoint with all accounts and no date limit. It is not a transaction count or exact preview simulation. An active rule alone does not prove history ran.

A timeout, network error, cancellation, 5xx, malformed response, or failed readback after a write can leave the outcome uncertain. Report the known rule ID/state and stop for inspection; do not claim no change, blindly retry creation/execution, automatically roll back, or replay a batch. A successful DELETE response is sufficient to report deletion.

## Compatibility and deployment

The compatibility target and endpoint details are in [API_COMPATIBILITY.md](API_COMPATIBILITY.md). When Firefly changes, recheck rule schemas, allowlists, preview translation, trigger semantics, and all-account defaults before expanding support.

For upgrades, remove the retired `allowBestEffortPendingRuleDeletion` config key before starting this strict-schema version. Rebuild generated `dist/`, restart the Gateway, and first perform a read-only verification. Pulling source alone does not update a path-installed plugin.

`plugin:validate` cannot run on Node 24.13.0 because OpenClaw hits a `node:sqlite` embedded-NUL issue. Use Node 24.16+ or 26.1+; this is a validation-environment limitation, not evidence that the plugin contract is invalid.
