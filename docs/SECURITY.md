# Security model

## Exposed capability

The plugin reads bounded Firefly data, creates minimal expense accounts/categories/tags, updates individual single-entry transactions through a conversion/tagging allowlist, and manages only marked Firefly rules. It does not expose arbitrary URLs, paths, methods, request bodies, request headers, transaction deletion, generic rule mutation/deletion, or arbitrary rule triggering.

`firefly_transaction_update` requires a canonical transaction group ID and at least one requested change. Conversion requires both distinct account IDs and `type: "transfer"`; tags are additive. Splits and budget-linked transfers/conversions are rejected. Rules and webhooks are disabled for the PUT. Readback verifies the requested changes and core preserved fields. There is no dry run or automatic retry. Read/update/readback is not atomic: concurrent edits may be overwritten, and an uncertain result requires inspection. There is no deletion, rollback, or automatic pair matching.

Historical execution is exposed only through `firefly_rule_execute`. It requires an active managed rule and `confirmed: true`, and always targets all accounts and all dates. There is no backend version gate; API failures are reported normally.

## Managed-rule boundary

A managed rule has an anchored first-line description marker:

```text
[openclaw-firefly:managed:v1]
```

Legacy anchored `pending:v1` and `confirmed:v1` OpenClaw headers are accepted for migration. The marker is a management convention, not a cryptographic signature or authentication boundary. Firefly's current stored rule is authoritative; old digests, proposal IDs, and expiry metadata are not checked.

Only managed rules can be changed by the managed-rule tools. Updates and deletion require the rule to be inactive. An active rule must be explicitly deactivated, with `confirmed: true`, before it can be edited or deleted. Activation, deactivation, deletion, and historical execution each require `confirmed: true`.

`confirmed: true` is a model-supplied invocation value and cannot prove human approval. The agent must obtain explicit approval in its interaction workflow, separately for activation and for full-history execution. After any edit, preview and review the current rule again.

Sequence same-rule and dependent operations. This avoids making a later action depend on an unverified earlier mutation. Independent operations on different rules need no blanket serialization.

## Action policy

Allowed action keywords are `set_category`, `set_budget`, `add_tag`, `remove_tag`, `set_description`, `set_notes`, `set_source_account`, `set_destination_account`, and `convert_transfer`. Unknown actions fail closed.

Before create, update, and activation, named category, active-budget, tag, and active-account targets are validated. Duplicate singleton actions and conflicting tag add/remove actions are rejected. Amount/currency changes, deletion, arbitrary transaction-type conversion, webhooks, and other unreviewed actions remain unavailable.

## Mutation uncertainty

A successful create, update, activate, or deactivate is followed by a readback of the relevant stored outcome. A successful DELETE is reported from its response. Timeout, cancellation, connection loss, 5xx, malformed response, or failed readback can leave a mutation uncertain. The plugin reports that uncertainty instead of claiming no change, and callers must inspect Firefly before retrying. Historical execution must never be blindly replayed because it may have partially applied.

## Secrets and transport

- `accessToken` and `headers.*` are OpenClaw secret-input paths.
- Logs contain method, pathname, status, and duration—not token, header, query, or body values.
- Errors are normalized; reverse-proxy response bodies are not returned.
- HTTPS is required by default. `allowInsecureHttp` is only for a trusted local/test deployment.
- Redirects are rejected so credentials are not forwarded to another destination.

Do not put credentials, config dumps, raw reverse-proxy bodies, or financial payloads in reports. Revoke any credential that may have been disclosed.

Direct categorization: `categoryId` sets an existing category; `counterpartyAccountId` sets an active expense destination for withdrawals or active revenue source for deposits, preserving the bank/card side. Both are optional canonical numeric IDs, validated before PUT and verified on readback. Counterparty edits cannot accompany transfer conversion. Explicit categories replace existing categories; clearing is unsupported. Existing split, budget, tag-preservation, and uncertain-outcome safeguards remain.
