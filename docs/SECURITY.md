# Security model

## Exposed capability

The model can read a paginated subset of Firefly data and manage one constrained lifecycle: an inactive category-rule proposal owned by this plugin.

The plugin does **not** expose:

- an arbitrary URL, path, method, body, or request-header tool;
- transaction update/delete operations;
- Firefly rule trigger/execution endpoints;
- generic rule deletion;
- category, rule-group, account, or currency mutation;
- source/destination account, amount, currency, type, notes, webhook, or delete actions.

## Pending ownership

Firefly v6.7.2 has no dedicated arbitrary metadata field on `RuleStore`/`RuleUpdate`. The rule `description` field is therefore used for an anchored marker:

```text
[openclaw-firefly:pending:v1;proposal=<uuid>;digest=<sha256>;created=<ISO-8601>;expires=<ISO-8601>]
```

The marker is followed by the user-visible description. Its digest covers the canonical inactive proposal (title, group, moment, order, strict/stop flags, active trigger/action entries and user description). Update, confirmation, and rejection require a valid marker, matching digest, and `active === false`. Confirmation additionally requires the exact digest returned to the reviewer.

A module-level keyed mutex serializes these sequences per canonical non-zero rule ID within one Gateway process. Firefly-normalized responses are re-signed while inactive; descriptions are decoded from Firefly's one-layer HTML escaping before every PUT to avoid double escaping. Confirmation verifies a complete inactive snapshot, then uses a minimal `{ active, description }` activation PUT. Failed, timed-out, or semantically mismatched activation is followed by an ownership-checked attempt to restore the reviewed inactive snapshot. If that cannot be verified, the tool returns `FIREFLY_ACTIVATION_UNCERTAIN` and the operator must inspect and deactivate the rule before continuing. This is defense in depth, not cross-process CAS: v6.7.2 has neither conditional PUT nor conditional DELETE. Rejection is disabled by default. Enabling `allowBestEffortPendingRuleDeletion` is supported only with **no external rule writers** (UI, another gateway, or another token), because its GET/check/DELETE race is unavoidable.

## Action policy

Only exact action keyword `set_category` is allowed. The target category name is verified against existing Firefly categories before create, update, or confirm. This matters because Firefly's `SetCategory` implementation can otherwise create a missing category when a rule runs.

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
