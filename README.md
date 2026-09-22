# openclaw-firefly

A security-constrained OpenClaw plugin for reading Firefly III data and managing marked Firefly rules.

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
- The plugin exposes no arbitrary URL/header/HTTP tool, transaction mutation or deletion, generic rule mutation, or arbitrary trigger endpoint.
- Historical execution is supported only for Firefly III v6.7.2 and is always all-accounts/all-dates. Preview is search-based and may be truncated or unable to provide an exact total.
- A timeout, network failure, 5xx, cancellation, or failed mutation readback can leave the outcome uncertain. Inspect Firefly before retrying; do not assume no change occurred.

## Requirements

- Node.js 24.16+ or 26.1+
- OpenClaw >= 2026.5.17
- Firefly III v6.7.2 for historical execution
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

Direct constrained creation: `firefly_expense_account_create`, `firefly_category_create`, and `firefly_tag_create`.

Managed-rule tools: `firefly_rule_create`, `firefly_rule_update`, `firefly_rule_activate`, `firefly_rule_deactivate`, `firefly_rule_delete`, and `firefly_rule_execute`.

## Legacy managed rules

Rules whose first description line is a recognized legacy `pending:v1` or `confirmed:v1` OpenClaw marker remain managed. Old UUID, digest, and expiry metadata are not validated. The next requested update, activation, or state-changing write normalizes the marker to `managed:v1`; reads, previews, execution, and state-toggle no-ops do not write merely to migrate it.

## Compatibility

The plugin's API behavior is documented in [docs/API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md).
