# Firefly III API compatibility

## Verification target

The rule and transport contracts were checked against Firefly III `v6.7.2`, its versioned OpenAPI file, and relevant route, validator, transformer, and rule-action source. Rule operations do not query `/about` or require an exact backend version. This removes a policy gate, not API validation or a guarantee of compatibility with every release.

Upstream references:

- <https://github.com/firefly-iii/firefly-iii/tree/v6.7.2>
- <https://github.com/firefly-iii/api-docs/blob/main/dist/firefly-iii-v6.7.2-v1.yaml>

## API behavior used

Read/create/update responses use JSON:API-style envelopes (`application/vnd.api+json`); requests use `application/json`. The client accepts both JSON media types.

The plugin uses Firefly's transaction, metadata, account, rule, and rule-group read endpoints, plus constrained creation endpoints for expense accounts, categories, and tags. Rule operations use:

| Operation | Endpoint |
|---|---|
| list/get/create/update/delete rule | `/v1/rules` and `/v1/rules/{id}` |
| preview | `GET /v1/rules/{id}`, then `GET /v1/search/transactions` |
| historical execution | `POST /v1/rules/{id}/trigger` |

The documented native rule-test endpoint was not used because a verified v6.7.2 deployment returned no matches where the web preview matched. `firefly_rule_test` instead translates the persisted supported triggers to Firefly search queries. Strict rules use one AND query; non-strict rules use ordered searches whose results are unioned. Unsupported triggers fail closed. A preview reports its result cap/truncation and only reports an exact count when Firefly supplies one.

## Managed rules and updates

### Targeted transaction updates

`firefly_transaction_update` uses `GET /v1/transactions/{id}`, a narrow `PUT` to the same group ID, then a verifying `GET`. Its payload contains `apply_rules: false`, `fire_webhooks: false`, and one `transactions` entry containing the existing `transaction_journal_id` plus the requested conversion fields and/or merged tags. Splits are rejected because omitted journals can be removed by a group update. No deletion endpoint is used. Transfer updates with an existing budget are rejected because v6.7.2 removes the budget regardless of omitted update fields.

The update schema and v6.7.2 source were inspected; automated coverage uses stub clients and a local HTTP fixture, not a live Firefly write test. This does not establish production write permissions or verify all server-side effects. Uncertain writes and failed readbacks require inspection rather than automatic retry. The API supplies no atomic read/modify/write guarantee.

Firefly has no dedicated rule metadata field, so the description's anchored first line is the management marker. The current marker is:

```text
[openclaw-firefly:managed:v1]
```

Legacy anchored `pending:v1` and `confirmed:v1` headers are also recognized. Their UUID/digest/expiry contents are opaque and are not verified. A requested update, activation, or actual deactivate write normalizes a legacy marker; reads, previews, execution, and already-correct state toggles do not write only to migrate it.

`RuleUpdate` supports partial updates. Scalar edits use the supplied fields. Supplying `triggers` or `actions` replaces the corresponding array, so callers must first read and copy every entry, including trigger `prohibited` and per-entry `active` and `stopProcessing` flags. New entries default to active and not-stop-processing. The plugin checks requested scalar and array values and flags in the GET readback but does not reject harmless server normalization of unrelated fields.

Creates request `active: false`; updates require an inactive managed rule. Activating/deactivating use a minimal active/description update and GET readback. Delete requires an inactive managed rule and relies on a successful DELETE response rather than an impossible post-delete readback.

## Historical execution

`POST /v1/rules/{id}/trigger` is a synchronous full-history operation. The plugin sends `{ "accounts": [] }`, which is the v6.7.2 all-accounts behavior, and omits dates, meaning all dates. It accepts only an active managed rule and `confirmed: true`; it has no preview receipt and does not make a filtered preview an execution boundary. Preview and explicit approval remain workflow responsibilities.

The endpoint can have partial effects before a timeout, network failure, cancellation, malformed response, or 5xx. Such outcomes are reported as uncertain and must be inspected, not blindly retried.

## Rule safety policy

`RuleStore` creation requires title, group, moment, triggers, and actions. The plugin forces inactive creation and supports the documented rule moments `store-journal`, `update-journal`, and `manual-activation`.

The action allowlist is `set_category`, `set_budget`, `add_tag`, `remove_tag`, `set_description`, `set_notes`, `set_source_account`, `set_destination_account`, and `convert_transfer`. Referenced categories, active budgets, tags, and active accounts are checked by exact name. New actions remain denied until reviewed.

## Upgrade policy

When upgrading Firefly, rerun lifecycle coverage and review rule schemas, trigger/action enums, response normalization, web rule-to-search translation, `/rules/{id}/trigger` semantics, and the all-account default. The plugin does not enforce a version allowlist; incompatibilities surface through ordinary API errors and response checks.

Direct categorization: `categoryId` sets an existing category; `counterpartyAccountId` sets an active expense destination for withdrawals or active revenue source for deposits, preserving the bank/card side. Both are optional canonical numeric IDs, validated before PUT and verified on readback. Counterparty edits cannot accompany transfer conversion. Explicit categories replace existing categories; clearing is unsupported. Existing split, budget, tag-preservation, and uncertain-outcome safeguards remain.
