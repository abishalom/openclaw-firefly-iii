# Firefly III plugin: findings and simplification plan

Repository: [abishalom/openclaw-firefly-iii](https://github.com/abishalom/openclaw-firefly-iii)

Reviewed revision: `43c4481660baf970f84df39a2ab68c533af08d58` — current `main` when preparing this document.

Status: implementation complete in the proposed 0.3.0 release, including deactivation and final readback fixes. All work groups completed. `npm run check` passes on Node 26.9.0: build, 41 tests (one opt-in live test skipped), plugin metadata check, and OpenClaw plugin validation. The earlier Node 24.13.0 validation blocker is resolved by using the supported runtime. No deployment or live Firefly mutations were performed; installed plugin revision and live rule payloads remain unverified. Findings below describe the original reviewed revision.

## 1. Goal and operating assumptions

Make everyday rule creation, editing, activation, deletion, and historical execution straightforward for a personal Firefly installation.

- One trusted operator and one OpenClaw gateway.
- No external rule writers during these operations. Sequence changes to the same rule and dependent operations (for example, delete-before-replacement). Independent operations on different rules may run concurrently; do not build locking machinery.
- Manual edits in Firefly are legitimate; they should not permanently invalidate plugin-managed rules.
- Firefly's current stored rule is the source of truth.
- Human approval is enforced by the agent's workflow, not by cryptographic proposal fingerprints.
- Keep ordinary input validation, explicit activation/execution approval, and honest reporting of API failures.

Do not build a concurrency framework, proposal database, signing system, expiring approval-token system, or automatic rollback engine.

## 2. Reported issues

| Operation | Reported result | What is established |
| --- | --- | --- |
| Delete rules 103–110 before creating six replacements | Blocked by `allowBestEffortPendingRuleDeletion` | The plugin disables pending-rule deletion by default. This is a plugin policy, not evidence that Firefly disallows deletion. |
| Edit rule 115 — Claudia Maid | Rejected as not an intact inactive pending proposal | The edit was reported as unapplied. Fresh creation and inactivity alone do not satisfy the plugin's current ownership/digest checks. |
| Activate rules 111, 112, 113, 114, and 116 | All reported `FIREFLY_RULE_NOT_PENDING` | The agent reported none activated or ran. Live state has not been independently inspected. |

Requested edit to rule 115:

- Trigger: `description_starts`.
- Old value: `Zelle payment to CLAUDIA`.
- New value: `Zelle payment to CLAUDIA JPM`.
- Preserve every other condition, action, and setting; leave the rule inactive.
- Preview should check actual matching payments, including the intended exclusion of Claudia Loinz; that outcome has not been independently verified.

## 3. Confirmed code findings

### 3.1 One integrity check blocks several otherwise ordinary operations

`assertPendingRule()` rejects a rule if any of these hold:

1. The pending marker in the description cannot be parsed.
2. The rule is active.
3. The stored proposal digest differs from a freshly computed digest.

Update, rejection/deletion, and activation all call this check. Consequently, a rule may exist, be inactive, and still be unusable through all three tools.

Activation also compares the caller's `expectedProposalDigest` with the marker. `FIREFLY_RULE_NOT_PENDING` alone therefore does not establish which check failed. In the reviewed activation path, these validation failures occur before the activation PUT.

Sources: [rule-safety.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/rule-safety.ts), [service.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/service.ts).

### 3.2 Expiration is not the cause established by this code

The marker contains creation and expiry timestamps, and parsing validates their format. However, the pending-rule check does not compare expiry with the current time. An elapsed 24-hour timestamp does not itself cause this error in the reviewed revision.

The separate historical-execution preview receipt does have an enforced 15-minute lifetime. These are different mechanisms and should not be confused.

Sources: [rule-semantic-digest.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/rule-semantic-digest.ts), [service.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/service.ts).

### 3.3 Digest validation creates normalization sensitivity

The proposal digest includes title, rule group, top-level rule order, trigger moment, strict/stop flags, trigger/action contents and sequence, and the user description. Numeric child trigger/action order values are already excluded; their array sequence remains significant.

Creation and update call `resignPendingRule()`, which derives its state from POST/PUT responses and can issue repeated description updates. It can return without a fresh authoritative GET. Activation uses a subsequent GET and then checks the digest again.

This provides a plausible failure mechanism if write responses differ from later reads, or if another sequential operation causes Firefly to renumber an earlier rule. It is not proof that either occurred for rules 111–116.

Sources: [rule-semantic-digest.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/rule-semantic-digest.ts), [service.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/service.ts).

### 3.4 Deletion has a separate concurrency-related opt-in

`rejectPendingRule()` first checks `allowBestEffortPendingRuleDeletion`, then validates the pending rule, then deletes it. Enabling the setting does not bypass the pending integrity check.

The setting exists because the plugin cannot atomically validate and delete a rule against other writers. Under the accepted workflow assumptions (no external writers; same-rule and dependent mutations sequenced), this opt-in and the associated locking machinery are unnecessary complexity.

Source: [service.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/service.ts).

### 3.5 Historical execution has another independent stateful gate

The current execution path requires an active confirmed rule with an intact digest, a matching single-use preview receipt, matching backend identity and rule contents, and `confirmed: true`. Receipts are kept in an in-memory map, so a gateway process restart discards them even if the conversation survives.

The reviewed implementation executes against all accounts and dates using the Firefly v6.7.2 trigger endpoint. Filtered previews do not narrow that execution request.

Source: [service.ts](https://github.com/abishalom/openclaw-firefly-iii/blob/43c4481660baf970f84df39a2ab68c533af08d58/src/service.ts).

## 4. Corrections and remaining uncertainty

Earlier explanations in the conversation overstated the diagnosis:

- Expiration was not established as a cause and is not checked for elapsed time here.
- Failure of all five activations does not prove digest mismatch; missing markers or a stale caller digest can also cause validation failures.
- Earlier rules showing `pending: false` while a later one shows `pending: true` would be suggestive, not conclusive evidence of order renumbering.
- Deleting and recreating one rule is not a proven fix and is unnecessary for the proposed migration.

To prove the exact old failure, compare a rule's create response with its later GET response, full error text, marker, and recomputed digest using the installed code revision. Do not build a new diagnostic framework just for this: existing payloads and a small regression fixture are sufficient if available.

The simplification below can proceed without claiming a specific field caused the failures.

## 5. Recommended model: managed rules, not signed proposals

Store only a recognizable first-line marker:

```text
[openclaw-firefly:managed:v1]
Optional human-readable description follows here.
```

Return `managed: true/false` and Firefly's `active` flag. An inactive managed rule is a draft; an active managed rule is enabled. There is no separate signed pending/confirmed lifecycle.

The marker is a management convention, not an authentication boundary. A trusted user may edit the rule in Firefly; subsequent plugin operations use the current contents.

### Keep

- Creation forced inactive.
- Managed-marker checks before mutation.
- Inactive-only editing and deletion.
- Separate activation, deactivation, and historical execution, each requiring `confirmed: true`.
- Existing trigger/action allowlists and target-existence validation.
- Secret handling, configured proxy headers, HTTPS policy, timeouts, bounded responses, and pagination.
- Correct description decoding and Firefly request/response normalization.
- Fresh GET results after create, update, and activation.
- Clear distinction between a known failure and an uncertain mutation outcome.

### Remove

- Proposal UUIDs, semantic digests, expiry metadata, and re-signing loops.
- Digest-bound activation and confirmed-marker integrity checks.
- Preview receipt storage, receipt TTLs, receipt consumption, and credential fingerprints used only to bind receipts.
- `allowBestEffortPendingRuleDeletion` and rule/group mutexes.
- Complex automatic activation rollback and failed-creation deletion workflows.

Keep the existing supported Firefly version restriction for historical execution initially. Removing workflow bookkeeping does not establish compatibility with untested API versions.

## 6. Minimal tool contract

Suggested names are below. Update tool schemas, descriptions, and the agent's instructions together; do not maintain two independent lifecycle implementations.

| Tool | Requirements | Behavior |
| --- | --- | --- |
| `firefly_rule_create` | Valid supported rule fields | Add marker, create inactive, GET and return stored rule. |
| `firefly_rule_update` | Managed and inactive | Apply requested changes, preserve omitted fields, keep inactive, GET and return. |
| `firefly_rule_delete` | Managed and inactive; `confirmed: true` | DELETE; return ID and confirmed deletion status. |
| `firefly_rule_activate` | Managed; `confirmed: true` | Validate current rule, set active, GET and verify; if already active, return that status without running history. |
| `firefly_rule_deactivate` | Managed; `confirmed: true` | Set inactive, GET and verify; if already inactive, return a clear no-op status. Never execute history. |
| `firefly_rule_test` | Existing rule and supported preview triggers | Return search-based preview, examples, count when known, truncation, and preview scope; no receipt. |
| `firefly_rule_execute` | Managed and active; `confirmed: true` | Validate current rule, execute full history once, report API outcome and scope. |

Existing list/get and metadata tools remain, with rule results reporting `managed` and `active` instead of proposal lifecycle fields. Deactivation allows the chat workflow to disable a rule before editing it; editing does not automatically deactivate or reactivate a rule.

### Editing must really mean “leave everything else unchanged”

Read the current rule, merge only supplied fields, and preserve all omitted settings. For array inputs, explicitly document that supplied triggers/actions replace the corresponding array. The agent must therefore read the whole array and change only the intended entry.

Prefer minimal Firefly update payloads for scalar edits, activation, and deactivation. When the API requires sending a complete triggers/actions array, preserve the other entries and flags; do not reset them to default values. Harmless numeric order normalization must not cause rejection, but requested trigger/action values should still be checked in the readback.

For rule 115, change only the matching `description_starts` value, retain the other conditions and actions, and verify the returned rule remains inactive.

### Activation and historical execution stay separate

Activation enables the rule according to its configured trigger and group state; it does not mean existing transactions were processed. Report that distinction explicitly.

Historical execution remains an all-accounts/all-dates operation in this version. The agent should preview the current full-scope rule and obtain approval for that scope. A date-filtered preview or a handful of examples must never be described as the execution boundary. Show an exact match count only when the preview actually supplies one; otherwise disclose truncation or uncertainty.

Without receipts, the plugin deliberately does not prove that the approved preview and execution rule are identical. The trusted workflow owns that responsibility: sequence operations on the same rule, and if a rule is edited after review, preview and review it again. `confirmed: true` records the invocation's confirmation step; it is not independent evidence of human approval.

## 7. Migration without recreating rules

Recognize these anchored first-line marker forms as managed:

1. New `managed:v1` marker.
2. Legacy `pending:v1` marker.
3. Legacy `confirmed:v1` marker, for existing activated rules and execution.

For legacy forms, identify the recognizable marker header but do not validate the old digest, proposal UUID, expiry, or stored contents against today's rule. Do not match arbitrary mentions of OpenClaw elsewhere in the description. Preserve the human description after the marker.

Normalize legacy descriptions to the new marker on the next requested create/update/activation/deactivation write. Already-active activation and already-inactive deactivation remain no-ops; do not write merely to migrate their markers. Reads and previews must not write merely to migrate a marker. Execution can accept a legacy marker without a separate migration PUT.

Keep rule IDs and contents intact. No bulk delete/recreate, automatic activation, automatic backfill, or mandatory migration job. Rules without a recognized marker remain unmanaged and require separate explicit adoption if that is ever needed.

Remove `allowBestEffortPendingRuleDeletion` from the user's installed plugin configuration during upgrade, before starting the version that no longer accepts it. Leaving a deleted option in a strict config schema can prevent startup.

## 8. Simple error handling, not rollback machinery

Use specific errors such as `RULE_NOT_MANAGED`, `RULE_MUST_BE_INACTIVE`, `RULE_MUST_BE_ACTIVE`, `CONFIRMATION_REQUIRED`, and `MUTATION_UNCERTAIN`, alongside existing validation/API errors. Include the rule ID when known.

- After a successful create/update/activation/deactivation request, GET the stored rule and check the relevant outcome. Do not demand equality of every server-normalized field.
- DELETE is the exception to “GET after every mutation”: the object is gone. A successful DELETE response is sufficient; an optional verification GET should expect 404.
- A GET of an active rule does not prove historical execution completed. Report the trigger endpoint's outcome, not a fabricated transaction count.
- A timeout, connection loss, 5xx, or failed readback can leave a write's outcome uncertain. Do not report “nothing changed” without evidence, and do not blindly retry creation or historical execution.
- Do not automatically delete failed creations or replay rule batches. Report the known ID/current state and stop for inspection.
- If creation unexpectedly returns an active rule, report the violated inactive-creation expectation prominently; do not silently proceed with review as though it were a draft.
- Sequence same-rule and dependent operations. Independent rules may be processed concurrently, but no concurrency scheduler or batch engine is needed. Report completed, failed, and uncertain IDs honestly; do not start dependent follow-up work after failure/uncertainty. A batch is not atomic.

These rules address ordinary network/API failures, not concurrency, and do not require durable receipts, retry orchestration, or compensating transactions.

## 9. Implementation checklist

1. Replace digest/marker logic with small `isManaged`, `assertManaged`, `assertInactive`, and description-formatting helpers. Delete unused hashing/signing code.
2. Simplify rule normalization to report `managed` and `active`; remove proposal digest and expiry fields.
3. Refactor create/update/delete/activate and add simple deactivate as described, preserving unrelated fields and using authoritative readbacks.
4. Remove execution receipts and digest checks; retain full-history scope, API compatibility validation, and uncertain-execution reporting.
5. Remove locks, deletion opt-in configuration, and complex rollback/cleanup helpers. Keep unrelated transport/security behavior unchanged.
6. Update tool schemas/descriptions, manifest, README, configuration/security docs, and any installed agent workflow instructions.
7. Replace lifecycle tests with a compact suite matching the accepted workflow. Delete obsolete digest/receipt/rollback tests; do not build a replacement test framework.
8. Build the plugin, update the installed artifact/config, restart the gateway, and verify a read-only call before resuming mutations. For path installations, pulling source without rebuilding `dist/` is insufficient.

## 10. Acceptance tests

- Create several inactive managed rules sequentially; all remain editable/activatable despite numeric order normalization or differences between write responses and GET readback.
- Update legacy rule 115 with a deliberately stale digest: only the requested trigger value changes, the human description survives, and the rule stays inactive.
- Recognize legacy pending and confirmed markers without enforcing their old digests or elapsed expiry timestamps; missing markers still fail clearly.
- Reject edits/deletion of active rules; reject activation/deactivation/execution/deletion without `confirmed: true`.
- Deactivate a managed rule with a minimal update, verify inactive readback and preservation of unrelated fields, and return a no-op for an already-inactive rule. Neither state toggle executes history.
- Activate legacy drafts successfully; verify the activation path never calls historical execution. Already-active activation returns a clear no-op status.
- Execute active managed/legacy-confirmed rules without a preview receipt, including after reconstructing the service as on restart.
- Keep allowlist/target validation and existing read-only tools working.
- Preserve untouched trigger/action entries and flags during edits. Decode/encode descriptions without accumulating HTML escapes or duplicate marker lines.
- Simulate mutation timeout and readback failure: return uncertainty, no blind retry or automatic delete/rollback.
- Verify full-history execution scope is explicit and preview truncation is not misreported as an exact total.

Use mocks for most tests. Any live mutation test should run on disposable test rules with explicit authorization, not on the reported production IDs as an automated test suite.

## 11. Practical rollout for the affected rules

After deploying the refactor, read rules 111–116 and inspect their current contents; do not assume their state is unchanged since the earlier messages. Adopt recognized legacy markers in place. Apply and verify the rule 115 edit while inactive. Preview the intended rules, confirm the activation set with the user, and activate sequentially. Run historical execution only if separately approved for its full scope.

Bottom line: keep a management marker, current-state checks, explicit approval, and ordinary API validation. Replace the signed-proposal lifecycle outright. Add only the small deactivation operation needed to edit enabled rules in chat. Aim for substantially less production code, fewer tests tied to implementation machinery, and fewer configuration knobs—not a replacement state-management system.

## 12. Worker groups and integration order

These are assignment-ready work packages, not authorization to change live rules or deploy. Workers share a checkout: only one worker writes at a time. The groups below separate ownership and review responsibility; they are not a reason to introduce extra abstraction or parallelize tightly coupled code edits.

### Group A — Managed-rule model and normalization

**Own:** `src/rule-safety.ts`, `src/rule-semantic-digest.ts` (delete), `src/schemas/rules.ts`, `tests/unit/rule-safety.test.ts`.

- Replace pending/confirmed integrity checks with small managed-marker and state helpers. Keep existing allowlist and target-validation behavior.
- Recognize anchored new and legacy marker headers without validating legacy digest/UUID/expiry. Preserve the human description and existing description decoding behavior.
- Normalize rule output to `managed` and `active`; remove proposal metadata. Preserve all editable trigger/action flags and settings.
- Delete hashing/signing helpers and obsolete tests. Keep focused coverage for markers, description round trips, state checks, and existing validation.

**Handoff:** exact exported helper/type names and any fields required for lossless edits. Identify broken downstream imports for B/C, rather than adding temporary compatibility shims. A standalone full build need not pass until consumers are migrated.

### Group B — Direct API lifecycle and execution

**Depends on:** A.

**Own:** `src/service.ts`, `src/errors.ts`, `tests/integration/pending-rule-lifecycle.test.ts` (rename to `managed-rule-lifecycle.test.ts`).

- Implement create/update/delete/activate/deactivate/test/execute using the minimal contract in section 6. Keep method names aligned with those operations; pass `confirmed` to service mutations that require it and enforce it at runtime.
- Preserve omitted fields, replace only explicitly supplied arrays, use minimal update payloads where supported, and check relevant readback outcomes without whole-rule equality.
- Delete re-signing, receipt maps/TTLs/fingerprints, rule/group locks, deletion opt-in handling, automatic cleanup and rollback. Remove obsolete constructor parameters.
- Keep historical execution compatible with the currently supported Firefly version and explicitly all-accounts/all-dates. Do not add preview-token substitutes or retry orchestration.
- Implement honest uncertain-write reporting and no-op state toggles. No automatic history execution.
- Replace old lifecycle tests with compact mocked coverage of section 10, including stale legacy markers, lossless edits, state toggles, and uncertain outcomes.

**Handoff:** final service signatures/result shapes, uncertainty semantics, and test results. Flag any receipt-only client plumbing for removal by C.

### Group C — Public tools, configuration, and remaining consumers

**Depends on:** A and B.

**Own:** `src/index.ts`, `src/config.ts`, `openclaw.plugin.json`, `src/client.ts`, `src/rule-preview.ts`, `tests/unit/plugin.test.ts`, `tests/unit/config.test.ts`, `tests/unit/client.test.ts`, `tests/unit/rule-preview.test.ts`, `tests/unit/creation-tools.test.ts`, `tests/integration/firefly-read.test.ts`, `tests/integration/firefly-v672-live.test.ts`.

- Replace old proposal tools with the section 6 tool names and schemas; add deactivation. Do not keep two lifecycle implementations or obsolete digest/receipt arguments.
- Remove the deletion opt-in from configuration/schema and update service construction.
- Make activation versus full-history execution explicit in tool descriptions. Preserve preview scope/count/truncation reporting without receipts.
- Remove client/preview code only where unused after receipt removal; preserve transport protections and unrelated behavior.
- Update affected consumer tests. Live integration tests must remain opt-in and must not mutate the reported production IDs.

**Handoff:** final tool inventory, removed configuration keys, focused test results, and any remaining references to retired concepts.

### Group D — Documentation and agent workflow

**Depends on:** final contracts from C.

**Own:** `README.md`, `docs/TECHNICAL_SPEC.md`, `docs/CONFIGURATION.md`, `docs/API_COMPATIBILITY.md`, `docs/SECURITY.md`, and this plan's completion notes.

- Replace signed-proposal instructions, examples, and security claims with the direct managed-rule workflow.
- Document explicit deactivation before editing active rules, array replacement semantics, separate activation/execution approval, and full-history warnings.
- Tell the agent to sequence same-rule and dependent operations; independent different-rule operations need no blanket ban. Re-preview after an edit. Do not claim `confirmed: true` proves human approval.
- Document legacy markers, removal of the old config option, build/restart requirements, and uncertain-outcome handling.
- Locate installed agent workflow instructions if available and report the required update; do not silently modify external installation files.

**Handoff:** concise upgrade checklist and any external instructions/configuration that still need operator-approved changes.

### Group E — Integrator review and build

**Depends on:** A–D. **Owner:** lead agent, with no other active writers.

- Run the repository's build and test commands. Check the combined diff for unrelated regressions and retired symbols, tool names, settings, and misleading security claims.
- Verify the compact acceptance suite covers the promised behavior; remove stale fixtures/tests rather than preserving obsolete lifecycle machinery.
- Review net production-code reduction and remaining complexity. No arbitrary line-count target, new framework, durable state store, compatibility mode, scheduler, or batch engine.
- Confirm emitted artifacts follow repository policy. Report changed files, tests, removed features, and deployment prerequisites.
- Deployment/configuration edits, gateway restart, and live rule changes are a separate operator-approved phase. Start with read-only verification after deployment, then follow section 11 only with the relevant mutation approvals.

### Scheduling summary

A → B → C → D → E. Assign one worker per implementation group and wait for its handoff before allowing the next writer to work in the shared checkout. Read-only review can run independently. This intentionally favors a small coherent replacement over parallel merge conflicts or temporary compatibility scaffolding.

## 13. Completion notes

### Group D — Documentation and agent workflow

Completed documentation updates in `README.md`, `docs/TECHNICAL_SPEC.md`, `docs/CONFIGURATION.md`, `docs/API_COMPATIBILITY.md`, and `docs/SECURITY.md` against the post-C public contract:

- Documents managed markers, including recognized legacy pending/confirmed headers, without digest, proposal, expiry, receipt, compatibility-mode, mutex, or rollback claims.
- Documents deactivate-before-edit, omitted-field preservation, full-array replacement for supplied triggers/actions, post-edit preview/review, distinct activation and execution approvals, full-history all-accounts/all-dates warnings, and mutation uncertainty.
- Directs sequencing for same-rule/dependent operations while permitting independent rules to proceed without blanket serialization.
- Records removal of `allowBestEffortPendingRuleDeletion`, required rebuild/restart/read-only verification for path installs, and the Node 24.13.0 `node:sqlite` embedded-NUL validation limitation (use Node 24.16+ or 26.1+).
- Array replacement callers must read and copy every trigger/action entry, including trigger `prohibited` and per-entry `active` and `stopProcessing` flags. New entries default to active and not-stop-processing; requested array values and flags are checked in the GET readback.

No repository-local agent workflow instruction file was found outside dependencies. The installed OpenClaw agent/skill workflow, if one is enabled separately, needs an operator-approved update to use the managed-rule sequence above and remove old pending/digest/receipt instructions. No external installation config or secrets were accessed or modified.
