# Security model

## Exposed capability

The model can read a paginated subset of Firefly data, directly create minimal expense accounts/categories/tags, and manage an inactive rule proposal lifecycle.

The plugin does **not** expose:

- an arbitrary URL, path, method, body, or request-header tool;
- transaction update/delete operations;
- arbitrary Firefly rule trigger/execution endpoints (only the receipt-bound all-history execute path exists);
- generic rule deletion;
- budget, rule-group, or currency creation/mutation, or category/tag/account mutation beyond minimal direct creation;
- amount, currency, webhook, arbitrary transaction-type, or delete actions.

## Pending ownership

Firefly v6.7.2 has no dedicated arbitrary metadata field on `RuleStore`/`RuleUpdate`. The rule `description` field is therefore used for an anchored marker:

```text
[openclaw-firefly:pending:v1;proposal=<uuid>;digest=<sha256>;created=<ISO-8601>;expires=<ISO-8601>]
```

The marker is followed by the user-visible description. Its digest covers the canonical inactive proposal (title, group, moment, order, strict/stop flags, active trigger/action entries and user description). Update, confirmation, and rejection require a valid marker, matching digest, and `active === false`. Confirmation additionally requires the exact digest returned to the reviewer.

A module-level keyed mutex serializes these sequences per canonical non-zero rule ID within one Gateway process. Firefly-normalized responses are re-signed while inactive; descriptions are decoded from Firefly's one-layer HTML escaping before every PUT to avoid double escaping. Confirmation verifies the reviewed inactive rule by GET, then uses a minimal `{ active, description }` activation PUT and authoritative GET readback. Failed, timed-out, or semantically mismatched activation is followed by an ownership-checked attempt to deactivate without restoring a full snapshot, so concurrent semantic edits are not overwritten. If that cannot be verified, the tool returns `FIREFLY_ACTIVATION_UNCERTAIN` and the operator must inspect and deactivate the rule before continuing. This is defense in depth, not cross-process CAS: v6.7.2 has neither conditional PUT nor conditional DELETE. Rejection is disabled by default. Enabling `allowBestEffortPendingRuleDeletion` is supported only with **no external rule writers** (UI, another gateway, or another token), because its GET/check/DELETE race is unavoidable.

## Historical execution

Historical execution requires an active intact OpenClaw-confirmed rule and a fresh, unfiltered v6.7.2 preview receipt bound to the configured backend/credential identity. It is synchronous but may partially mutate before a 5xx; 5xx, malformed/absent responses, timeout, cancellation, and network failures are uncertain and must be inspected rather than retried. `confirmed: true` is an explicit tool parameter and records the requested confirmation step, but model-supplied input cannot prove human approval; the tool instruction and approved interaction workflow provide that policy boundary.

## Action policy

The exact allowed keywords are `set_category`, `set_budget`, `add_tag`, `remove_tag`, `set_description`, `set_notes`, `set_source_account`, `set_destination_account`, and `convert_transfer`. Unknown keywords fail closed.

Before create, update, or confirmation, the plugin verifies exact existing names for categories, active budgets, tags, and active accounts. This prevents Firefly rule actions from creating near-duplicate metadata or silently targeting an unintended object. Duplicate singleton actions and contradictory add/remove operations for the same tag are rejected.

`convert_transfer` is the only transaction-type conversion exposed. Firefly has no generic `set_transaction_type` rule action. Withdrawal/deposit conversions remain denied because Firefly may create a missing expense or revenue account from their action value. Transfer conversion and account changes still require an inactive digest-bound proposal and explicit confirmation.

All unknown or newly introduced Firefly actions remain denied by default.

## Secrets and logs

- `accessToken` and `headers.*` are OpenClaw secret-input paths.
- Request logs contain method, pathname, status, and duration only.
- Query values, request/response bodies, bearer tokens, and custom-header values are not logged.
- Error responses are drained but not echoed; reverse-proxy bodies may contain sensitive diagnostics.
- Tool errors are normalized to safe code/status/message objects.

## Transport

HTTPS is required by default. `allowInsecureHttp` is an explicit operator setting for trusted local/test environments. Redirects are rejected so credentials are not forwarded to a different destination.

## Reporting

Do not include credentials, config dumps, raw reverse-proxy error bodies, or financial transaction payloads in a security report. Revoke any credential that may have been disclosed.
