# Firefly III API compatibility

## Verification target

Verified before implementation against:

- Firefly III tag `v6.7.2` (tag commit `e36b2ab28e838a47b6073288eb3273c67abf3380`; annotated tag object advertised as `10cceef11e89cc5445af920425deb4ce1db96ffe`).
- `firefly-iii/api-docs` versioned file `dist/firefly-iii-v6.7.2-v1.yaml` at repository commit `738ee5df30d9dd6e6bff5098f92d7b8c6fb02325` (SHA-256 `c888f791ac569e26265b9cc69ae5e640b22b5bc8df0f53330c90c36d53ae6534`).
- Relevant v6.7.2 source request validators, transformers, route definitions, and rule actions.

Upstream references:

- <https://github.com/firefly-iii/firefly-iii/tree/v6.7.2>
- <https://github.com/firefly-iii/api-docs/blob/main/dist/firefly-iii-v6.7.2-v1.yaml>

## Confirmed contracts

### Media types and envelopes

Read/create/update responses use `application/vnd.api+json` JSON:API-style envelopes:

- single: `{ data: { type, id, attributes, links? } }`
- collection: `{ data: [...], meta: { pagination }, links? }`

Requests use `application/json`. The client accepts both `application/vnd.api+json` and `application/json` responses.

### Read endpoints

| Operation | Endpoint | Confirmed parameters |
|---|---|---|
| list transactions | `GET /v1/transactions` | `page`, `limit`, `start`, `end`, `type` |
| get transaction | `GET /v1/transactions/{id}` | numeric/string path ID |
| search transactions | `GET /v1/search/transactions` | required `query`, `page`, `limit` |
| list categories | `GET /v1/categories` | `page`, `limit`, optional enrichment range |
| list budgets | `GET /v1/budgets` | `page`, `limit`, optional enrichment range |
| list tags | `GET /v1/tags` | `page`, `limit` |
| list accounts | `GET /v1/accounts` | `type=all`, `page`, `limit` |
| list rules | `GET /v1/rules` | `page`, `limit` |
| get rule | `GET /v1/rules/{id}` | ID |
| list rule groups | `GET /v1/rule-groups` | `page`, `limit` |
| documented native rule test | `GET /v1/rules/{id}/test` | `start`, `end`, repeated `accounts[]` |
| create expense account | `POST /v1/accounts` | `name`, fixed `type: "expense"`, optional `notes` |
| create category | `POST /v1/categories` | `name`, optional `notes` |
| create tag | `POST /v1/tags` | `tag`, optional `description` |
| historical rule trigger | `POST /v1/rules/{id}/trigger` | `{ "accounts": [] }` means the endpoint's all-accounts default; omitted dates mean all dates |

The native test endpoint returns `TransactionArray`, but a verified v6.7.2 deployment returned an empty set for a rule that Firefly's own web preview matched. The web preview does not call this endpoint: `Rule\IndexController::search` calls `RuleRepository::getSearchQuery` and redirects to Firefly search.

Accordingly, `firefly_rule_test` fetches the persisted rule and mirrors the v6.7.2 search translation inside the plugin, then calls `GET /v1/search/transactions`. Strict rules compile to one AND query. Non-strict rules compile to ordered per-trigger searches whose normalized results are unioned; trigger-level stop-processing is honored. Aliases, prohibited triggers, context-free triggers, optional date bounds, and optional account IDs are translated deterministically. Trigger types outside the plugin's reviewed allowlist fail closed. `maxResults` bounds normalized tool output and the result reports whether it was truncated.

### Direct metadata creation

The direct creation tools deliberately send only the documented fields above. In particular, Firefly's tag store field is `tag`, not `name`; the plugin maps its ergonomic `name` input to that upstream field. Expense-account type is selected inside the service and cannot be supplied by a tool caller.

### Historical rule execution

`POST /v1/rules/{id}/trigger` is Firefly's supported synchronous historical execution endpoint. v6.7.2's engine skips inactive rules while the endpoint still returns 204, so the plugin requires an active, intact OpenClaw-confirmed rule; activation changes semantics and therefore requires a fresh post-activation preview. The plugin sends `{ "accounts": [] }`, relying on the v6.7.2 all-accounts behavior, and omits date bounds for all dates. It exposes no narrower trigger payload. The search preview is inherently not an exact execution simulation: it has a result cap/pagination behavior and mirrors only the reviewed trigger subset.

A full-scope preview verifies `/about` is exactly v6.7.2 and yields an in-memory, 15-minute, single-use receipt binding the rule's normalized semantic digest, fixed scope, and a non-exported hash of canonical API base URL plus credential identity. Execution verifies the same backend/version and re-fetches/revalidates the rule before POSTing. Filtered previews are labelled `limited-preview-only` and cannot execute. The receipt is consumed before the mutation request, so a timeout, network failure, cancellation, or 5xx reports an uncertain outcome and cannot replay the same receipt. `confirmed: true` records the required execute invocation confirmation but is model input, not cryptographic proof of human approval; the tool instruction and calling workflow remain the human-approval boundary.

### `RuleStore`

Confirmed required fields: `title`, `rule_group_id` (or source-supported title alternative), `trigger`, `triggers`, and `actions`. Relevant fields are `description`, `order`, `active`, `strict`, and `stop_processing`. The plugin always supplies `rule_group_id`, forces `active: false`, and supplies active trigger/action entries.

### `RuleUpdate`

All fields are optional and partial updates are supported. The plugin sends complete snake_case snapshots (including top-level `order`/`stop_processing` and active trigger/action entries) for pending updates and confirmation's inactive verification write. After verifying that response against the reviewed digest, the final activation is a minimal partial update containing only `active` and the confirmed description marker.

### Rule enums

Top-level rule moments are:

- `store-journal`
- `update-journal`
- `manual-activation`

The plugin's trigger allowlist is copied from the v6.7.2 OpenAPI `RuleTriggerKeyword` enum. The v6.7.2 source validator derives a larger set from `config/search.php`; the published enum is incomplete. To avoid silently depending on undocumented values, this plugin exposes only the published subset.

The v6.7.2 source action configuration contains more keywords than the OpenAPI enum. The plugin accepts only the reviewed exact keywords `set_category`, `set_budget`, `add_tag`, `remove_tag`, `set_description`, `set_notes`, `set_source_account`, `set_destination_account`, and `convert_transfer`. Firefly expresses transaction-type changes as `convert_*` actions rather than `set_transaction_type`; only `convert_transfer` is exposed.

Named targets are checked against the read endpoints before create, update, and confirm. `convert_withdrawal` and `convert_deposit` remain denied because Firefly can create new expense/revenue accounts from their action values. Amount changes, deletion, account switching, cash-account shortcuts, bill/piggy-bank links, clear-all operations, and every other action remain denied.

### Ownership metadata

`RuleStore` and `RuleUpdate` have no extension/metadata property. The supported `description` field (max 32768 in source validation) is used for the ownership/pending marker and SHA-256 semantic proposal digest. v6.7.2's `Rule` model HTML-escapes descriptions, trims titles, canonicalizes context-free trigger values, and clamps rule order. The plugin derives the digest from each normalized response and re-signs with a description-only inactive PUT when needed. IDs are canonical positive decimal strings (zero and leading zeroes are refused). v6.7.2 provides no ETag/version precondition or conditional DELETE; the plugin's in-process mutex and GET/verify/re-PUT sequence are therefore best-effort against external writers, not an atomic cross-client guarantee. Pending deletion is opt-in and requires no external writers.

## Compatibility policy

Firefly upgrades require rerunning the lifecycle integration tests and reviewing:

1. `RuleStore` / `RuleUpdate` validators and schemas;
2. trigger and action keyword lists;
3. transaction/rule transformers;
4. the web rule-to-search translation and `/search/transactions` behavior;
5. `/rules/{id}/test` behavior, so the documented endpoint can be reconsidered if fixed;
6. `/rules/{id}/trigger` request validation, active-rule requirement, synchronous failure/partial-side-effect semantics, and all-account defaults;
7. account/category/tag store field validation and response transformers;
8. response media types and envelopes.

New action keywords are denied until explicitly reviewed.
