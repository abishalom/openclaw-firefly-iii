# Firefly III API compatibility

## Verification target

The rule and transport contracts were checked against Firefly III `v6.7.2`, its versioned OpenAPI file, and relevant route, validator, transformer, and rule-action source. Historical execution is deliberately restricted to an `/about` version of exactly `6.7.2`.

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

When upgrading Firefly, rerun lifecycle coverage and review rule schemas, trigger/action enums, response normalization, web rule-to-search translation, `/rules/{id}/trigger` semantics, and the all-account default. Do not expand historical execution support beyond v6.7.2 without that verification.
