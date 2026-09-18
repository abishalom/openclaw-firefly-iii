# OpenClaw ↔ Firefly III Integration
## Technical Specification for a Safe Rule-Proposal Plugin

**Status:** Implemented scope, revised for curated rule actions
**Target:** OpenClaw tool plugin + companion skill
**Verified against:** Firefly III **v6.7.2** (current stable as of 2026-09-17) and current OpenClaw tool-plugin/SecretRef documentation
**Recommended repository:** `openclaw-firefly`

---

## 1. Purpose

Build a small, security-constrained OpenClaw integration for an existing self-hosted Firefly III instance. The integration should help identify deterministic transaction-categorization patterns, create those patterns as **inactive Firefly rules**, preview the persisted rule through Firefly's search engine, present the proposal to the user in Telegram, and only activate the rule after explicit approval.

The system should avoid reimplementing Firefly's matching engine. Firefly III remains the source of truth for transactions and rule semantics; OpenClaw supplies reasoning, workflow, and human approval.

### 1.1 Primary goal

Reduce ongoing LLM involvement by converting recurring categorization decisions into native Firefly III rules.

### 1.2 Non-goals for v1

- No direct database access to Firefly III.
- No transaction deletion.
- No generic arbitrary HTTP tool.
- No generic Firefly rule deletion capability.
- No automatic activation of newly proposed rules.
- No execution/triggering of rules against historical transactions.
- No changes to transaction amount, currency, deletion state, or arbitrary financially sensitive fields. Account changes and conversion to transfers are allowed only through reviewed pending rules.
- No custom Firefly fork or modification.
- No separate microservice unless future constraints require one.

---

## 2. Recommended repository strategy

Create a dedicated Git repository named **`openclaw-firefly`**.

Reasons:

1. The plugin has its own release/version lifecycle independent of the main OpenClaw instance.
2. OpenClaw plugin SDK compatibility can be pinned and tested before gateway upgrades.
3. Credentials and deployment configuration can remain outside source control.
4. Unit/integration tests can run in CI.
5. The repository can later be packaged privately or publicly through npm/ClawHub if desired.

Recommended initial repository layout:

```text
openclaw-firefly/
├── package.json
├── package-lock.json
├── tsconfig.json
├── openclaw.plugin.json          # generated/validated plugin manifest
├── README.md
├── LICENSE                       # choose before publishing
├── .gitignore
├── src/
│   ├── index.ts                  # defineToolPlugin registration
│   ├── config.ts                 # config schema/helpers
│   ├── client.ts                 # Firefly HTTP client
│   ├── errors.ts                 # normalized error types
│   ├── schemas/
│   │   ├── common.ts
│   │   ├── transactions.ts
│   │   └── rules.ts
│   └── tools/
│       ├── transactions.ts
│       ├── categories.ts
│       ├── rules.ts
│       └── rule-groups.ts
├── skills/
│   └── firefly-categorizer/
│       └── SKILL.md
├── tests/
│   ├── unit/
│   │   ├── client.test.ts
│   │   ├── config.test.ts
│   │   └── rule-safety.test.ts
│   └── integration/
│       ├── firefly-read.test.ts
│       └── pending-rule-lifecycle.test.ts
└── docs/
    ├── TECHNICAL_SPEC.md
    ├── CONFIGURATION.md
    └── SECURITY.md
```

The implementation agent may simplify this structure if warranted, but the separation between HTTP client, tool definitions, safety validation, and the skill should remain.

---

## 3. Current platform assumptions

### 3.1 OpenClaw

Current OpenClaw tool-only plugins use `defineToolPlugin` from:

```ts
openclaw/plugin-sdk/tool-plugin
```

Current documented requirements include:

- Node.js **24.16+** or **26.1+**.
- TypeScript ESM package output.
- `typebox` as a runtime dependency.
- OpenClaw **>= 2026.5.17**.
- Package root ships `dist/`, `openclaw.plugin.json`, and `package.json`.

The plugin should use TypeBox schemas for configuration, tool inputs, and preferably outputs.

### 3.2 Firefly III

Firefly III stable version at specification time is **v6.7.2**.

The integration uses the Firefly III REST API under the configured base URL, normally:

```text
https://<firefly-host>/api/v1/...
```

Authentication should use a Firefly III Personal Access Token (PAT) or another supported bearer token appropriate for the deployment.

Important: Firefly III v6.6.0 invalidated previous OAuth tokens/clients. The implementation must not assume an old token remains valid; deployment documentation should instruct the operator to create a current credential for the running instance.

---

## 4. Architecture

```text
                           ┌─────────────────────┐
                           │      Telegram       │
                           │   Finance topic     │
                           └──────────┬──────────┘
                                      │
                               approval / edit
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                      │
│                                                          │
│  ┌────────────────────────┐   ┌────────────────────────┐ │
│  │ firefly-categorizer    │   │ openclaw-firefly      │ │
│  │ SKILL.md               │──▶│ tool plugin           │ │
│  │ workflow/reasoning     │   │ TypeScript            │ │
│  └────────────────────────┘   └───────────┬────────────┘ │
└────────────────────────────────────────────┼─────────────┘
                                             │ HTTPS
                                             │ bearer token
                                             │ custom headers
                                             ▼
                              ┌───────────────────────────┐
                              │     Firefly III v6.7+    │
                              │ transactions/categories  │
                              │ native rules + preview   │
                              └───────────────────────────┘
```

### 4.1 Responsibility boundaries

**Plugin**
- Implements authenticated HTTP calls.
- Adds required custom headers.
- Exposes narrowly scoped typed tools.
- Enforces safety restrictions that must not depend on prompt compliance.
- Marks/recognizes OpenClaw-created pending rules.
- Prevents confirmation/rejection of arbitrary user-created rules.

**Skill**
- Decides when to inspect transactions.
- Searches historical examples.
- Checks existing rules.
- Proposes deterministic rule logic.
- Creates an inactive pending rule.
- Calls the plugin's single rule-preview tool; the skill does not translate triggers.
- Summarizes matches/counterexamples.
- Presents the proposal in Telegram.
- Requires explicit user confirmation before activation.

**Firefly III**
- Owns transaction data.
- Owns categories.
- Owns rule semantics.
- Executes the search produced from the persisted rule.
- Runs confirmed rules during normal Firefly/data-import workflows.

**Telegram**
- Human review and approval surface.
- Prefer a dedicated Finance forum topic/session where available.

---

## 5. Connection and configuration

### 5.1 Required configuration

The plugin must support:

- `baseUrl`
- Firefly bearer token
- arbitrary additional HTTP request headers
- per-header literal values or secret-backed values
- request timeout
- optional TLS/network settings only if OpenClaw/plugin APIs make this necessary; do not weaken TLS by default

Conceptual config:

```json5
{
  plugins: {
    entries: {
      "openclaw-firefly": {
        config: {
          baseUrl: "https://firefly.example.com",
          accessToken: {
            source: "store",
            provider: "default",
            id: "FIREFLY_ACCESS_TOKEN"
          },
          headers: {
            "CF-Access-Client-Id": {
              source: "store",
              provider: "default",
              id: "FIREFLY_CF_CLIENT_ID"
            },
            "CF-Access-Client-Secret": {
              source: "store",
              provider: "default",
              id: "FIREFLY_CF_CLIENT_SECRET"
            },
            "X-Environment": "home"
          },
          requestTimeoutMs: 10000
        }
      }
    }
  }
}
```

The exact config encoding must follow the plugin SDK's supported secret-input schema at implementation time. Do not invent a custom secret storage mechanism if OpenClaw can resolve SecretRefs directly.

### 5.2 Secret handling

OpenClaw's current SecretRef contract supports `env`, `file`, `exec`, and `store` sources. The plugin should use SecretRefs for any credential-bearing fields that the current SDK allows.

Security requirements:

- Do not hardcode credentials in source.
- Do not write secrets to logs.
- Do not return resolved secrets from tool output.
- Do not include resolved secrets in thrown errors.
- Redact values for headers whose names suggest authentication/credentials.
- Ensure request debugging, if implemented, logs header names but not secret values.

### 5.3 Custom request headers

Every Firefly request must merge headers in the following conceptual order:

1. plugin defaults (`Accept`, `Content-Type` when applicable)
2. bearer `Authorization`
3. configured static/custom headers
4. per-request non-sensitive headers controlled internally by the plugin

The agent must **not** receive a tool parameter that allows arbitrary headers on individual calls. Custom headers are operator configuration, not model-controlled data.

This is required to support security layers such as Cloudflare Access, Pangolin/reverse-proxy access tokens, or another authenticated gateway between OpenClaw and Firefly.

---

## 6. Firefly API operations required

The following endpoints are the core API surface required for v1.

### 6.1 Transactions

| Plugin capability | Firefly API | Purpose |
|---|---|---|
| list transactions | `GET /v1/transactions` | Review recent transactions |
| get transaction | `GET /v1/transactions/{id}` | Inspect one transaction in detail |
| search transactions | `GET /v1/search/transactions` | Find historical examples and similar descriptions |

The plugin should preserve Firefly pagination rather than silently retrieving an unbounded history.

### 6.2 Categories

| Plugin capability | Firefly API | Purpose |
|---|---|---|
| list categories | `GET /v1/categories` | Resolve valid existing categorization targets |
| optional category details | `GET /v1/categories/{id}` | Only if needed by implementation |

No category create/update/delete tool is required for v1.

### 6.3 Rules

| Plugin capability | Firefly API | Purpose |
|---|---|---|
| list rules | `GET /v1/rules` | Avoid duplicate/overlapping rules; find pending proposals |
| get rule | `GET /v1/rules/{id}` | Inspect one rule |
| create rule | `POST /v1/rules` | Create a pending inactive proposal |
| update rule | `PUT /v1/rules/{id}` | Edit pending proposal; later activate after confirmation |
| preview rule | `GET /v1/rules/{id}` then `GET /v1/search/transactions` | Fetch persisted semantics, compile them inside the plugin, and find historical matches without changes |
| delete rule | `DELETE /v1/rules/{id}` | Internal-only implementation primitive for rejecting/expiring OpenClaw pending rules |

Firefly's web preview uses `RuleRepository::getSearchQuery`, not the documented native rule-test endpoint. The plugin mirrors that translation for its reviewed trigger subset and exposes safe optional date/account filters. Strict rules use one AND query; non-strict rules use ordered searches whose results are unioned inside the plugin.

The Firefly API also exposes `POST /v1/rules/{id}/trigger`. **Do not expose or use this in v1.** The purpose of v1 is to create future deterministic behavior, not bulk-edit historical data.

### 6.4 Rule groups

| Plugin capability | Firefly API | Purpose |
|---|---|---|
| list groups | `GET /v1/rule-groups` | Choose/verify the target group |
| get rules in group | `GET /v1/rule-groups/{id}/rules` | Optional overlap/context check |

Creating/updating/deleting rule groups is not required initially. Prefer configuring a target rule-group ID/name or selecting an existing group.

### 6.5 Optional API capability

Current Firefly routes include:

```text
GET /v1/rules/validate-expression
```

This may be added later if the chosen Firefly rule representation benefits from expression validation. It is not required for the basic trigger/action rule workflow.

---

## 7. OpenClaw tool contract

Do **not** expose raw Firefly REST endpoints one-for-one where doing so would bypass safety boundaries. The agent should receive semantic tools.

Recommended v1 tools:

### Read-only tools

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
firefly_rule_test
firefly_rule_groups_list
```

### Constrained write tools

```text
firefly_rule_create_pending
firefly_rule_update_pending
firefly_rule_confirm_pending
firefly_rule_reject_pending
```

The write tools should internally call Firefly's create/update/delete rule endpoints but enforce additional invariants.

### 7.1 `firefly_rule_create_pending`

Must:

- force `active = false` regardless of model input;
- attach a recognizable OpenClaw ownership/pending marker using the safest Firefly-supported textual metadata field available in the current rule model;
- record a creation timestamp and expiry timestamp if a supported metadata/description field is available;
- only allow approved rule triggers/actions;
- reject unsupported action types before making an HTTP request;
- return the created Firefly rule ID and normalized rule summary.

The implementation agent must inspect the **current v6.7.2 OpenAPI schema/source** for the exact `RuleStore` fields instead of relying on field names copied from this design document.

### 7.2 `firefly_rule_update_pending`

Must:

- fetch the rule first;
- verify that it is owned/marked as an OpenClaw pending proposal;
- refuse to modify ordinary Firefly rules;
- keep the rule inactive;
- reapply action allowlist validation.

### 7.3 `firefly_rule_confirm_pending`

Must:

- fetch the rule first;
- verify ownership/pending marker;
- only then update the rule to active;
- remove or replace the pending marker if practical;
- return the final active rule.

It must not accept arbitrary rule contents during confirmation. Confirmation means "activate the proposal that currently exists in Firefly," not "let the model rebuild it differently at the last moment."

### 7.4 `firefly_rule_reject_pending`

Must:

- fetch the rule first;
- verify ownership/pending marker;
- delete only that pending rule;
- refuse deletion of any non-pending/non-owned rule.

### 7.5 `firefly_rule_test`

Should accept:

- pending rule ID
- optional `start` / `end`
- optional account IDs
- pagination controls supported by Firefly

Should return a normalized transaction result sufficient for the agent to summarize:

- transaction/group ID
- date
- description
- amount and currency
- source/destination account names/IDs where appropriate
- existing category if available
- any fields necessary to identify counterexamples

Avoid dumping large raw API payloads into model context when a normalized representation is sufficient.

---

## 8. Rule-action safety policy

The plugin, not merely the skill, must enforce a hard allowlist.

### 8.1 Allowed actions

- `set_category`
- `set_budget`
- `add_tag`
- `remove_tag`
- `set_description`
- `set_notes`
- `set_source_account`
- `set_destination_account`
- `convert_transfer`

Named targets must already exist. Firefly uses `convert_transfer`, not `set_transaction_type`, for the supported transaction-type change.

### 8.2 Explicitly prohibited through this plugin

- delete transaction
- modify amount
- modify currency
- switch accounts
- convert to withdrawal or deposit
- include credentials or other secrets in descriptions or notes
- invoke webhook/network-related side effects
- execute rules against historical transactions
- arbitrary rule deletion

If Firefly adds new action types in a future release, they remain denied until explicitly reviewed and added to the allowlist.

---

## 9. Pending-rule lifecycle

### 9.1 Proposal workflow

```text
1. Skill finds an uncategorized/repeated pattern.
2. Skill checks existing rules.
3. Skill checks historical transactions.
4. Skill chooses an existing category.
5. Skill calls firefly_rule_create_pending.
6. Plugin creates inactive Firefly rule.
7. Skill calls firefly_rule_test on the actual persisted Firefly rule; the plugin translates it to Firefly search syntax and runs the preview.
8. Firefly returns transactions that WOULD match; no changes are made.
9. Skill summarizes results and sends proposal to Telegram.
10. User confirms, edits, or rejects.
```

### 9.2 Telegram proposal content

A proposal should contain, at minimum:

```text
Proposed Firefly rule

Condition:
  Description contains "SUPER 99"

Action:
  Set category → Groceries

Firefly test:
  14 historical matches

Existing categories among matches:
  12 Groceries
  1 Household
  1 Uncategorized

Representative examples:
  Sep 14 – SUPER 99 COSTA DEL ESTE – $121.15 – Groceries
  Sep 06 – SUPER 99 – $38.54 – Groceries
  Aug 29 – SUPER 99 – $76.10 – Household

Warning:
  1 historical counterexample

Pending rule ID: 123
Expires: <timestamp>
```

Telegram buttons are desirable if the OpenClaw channel API makes them easy to implement, but v1 correctness must not depend on custom Telegram UI. Plain conversational approval is acceptable:

- `Confirm rule 123`
- `Reject rule 123`
- `Edit rule 123: only match source account X`

### 9.3 Edit workflow

On edit:

1. fetch existing pending rule;
2. modify while inactive;
3. retest with Firefly;
4. send a revised proposal;
5. require a new explicit confirmation.

### 9.4 Expiry

Pending rules that are not confirmed within **24 hours** should be automatically removed.

Preferred design:

- pending rule contains a plugin-recognizable marker and creation/expiry metadata;
- cleanup job periodically lists rules;
- only inactive rules that are positively identified as plugin-owned pending proposals are eligible for deletion;
- age > 24h triggers `DELETE /v1/rules/{id}`;
- cleanup logs rule ID/title and timestamp, but not credentials or unnecessary transaction details.

If OpenClaw tool plugins do not provide a suitable background timer/service primitive, implement cleanup as a scheduled OpenClaw automation/cron workflow that calls a dedicated safe cleanup tool. Do **not** turn a tool-only plugin into a larger mixed-capability plugin solely to run the timer unless necessary.

---

## 10. Companion skill specification

Create a skill named approximately:

```text
firefly-categorizer
```

The skill must contain workflow policy rather than HTTP implementation.

### 10.1 Required behavior

The skill should instruct the agent to:

1. Focus on uncategorized or explicitly requested transactions.
2. Check existing Firefly rules before proposing a new rule.
3. Search historical transactions for recurring merchant/description patterns.
4. Prefer specific deterministic patterns over broad inferred patterns.
5. Use existing Firefly categories; do not invent/create categories in v1.
6. Avoid proposing a rule from one isolated example unless the user explicitly asks.
7. Create the candidate as an inactive Firefly rule.
8. Use `firefly_rule_test` on the persisted rule as the authoritative preview; trigger-to-search translation must remain inside the plugin.
9. Show representative matches and counterexamples.
10. Never confirm/activate a pending rule without explicit user approval in the conversation.
11. On edits, retest before presenting the revised rule.
12. If uncertainty is material, ask for categorization rather than inventing one.
13. Prefer native Firefly deterministic rules once a pattern is established, reducing future model work.

### 10.2 Recommended proposal heuristics

These are skill-level heuristics, not hard plugin constraints:

- Prefer >= 3 historical matches before proactively suggesting a permanent rule.
- Highlight category consistency ratio.
- Always surface known counterexamples.
- Avoid broad merchant rules for vendors likely to span categories (e.g. general marketplaces).
- Consider account context where merchant description alone is ambiguous.
- If Firefly test produces unexpectedly many matches, do not recommend confirmation without narrowing/review.

---

## 11. Telegram integration

No Firefly-specific Telegram plugin should be necessary. Use the existing OpenClaw Telegram channel.

OpenClaw currently isolates Telegram forum topics into topic-specific sessions and supports per-topic skill/agent configuration. A dedicated Finance topic is recommended.

Possible configuration concept:

```text
Telegram supergroup
└── Finance topic
    ├── dedicated session
    ├── firefly-categorizer skill enabled
    └── Firefly plugin tools allowed
```

The implementation should not require the Firefly plugin itself to know Telegram chat IDs. The agent/channel layer should render proposal results. This keeps the Firefly plugin channel-agnostic and reusable.

---

## 12. Error handling and observability

### 12.1 HTTP errors

Normalize at least:

- authentication failure (401/403)
- not found (404)
- validation error (422)
- rate/temporary server failures
- network timeout
- reverse-proxy/security-layer denial
- invalid/non-JSON response

Return structured safe errors to the agent. Example:

```json
{
  "code": "FIREFLY_AUTH_FAILED",
  "status": 401,
  "message": "Firefly rejected the configured credentials."
}
```

Do not echo response bodies if they may contain sensitive gateway details unless redacted.

### 12.2 Logging

Log:

- method
- Firefly path (not secret-bearing query values if sensitive)
- status
- duration
- tool name
- Firefly resource ID where useful

Never log:

- bearer token
- secret custom-header values
- full config object

### 12.3 Health check

Optional but useful: add an operator-only or agent-safe read tool such as:

```text
firefly_connection_check
```

It should call a harmless endpoint such as Firefly's about/current-user endpoint if appropriate and return version/authentication status. Verify the exact current endpoint before implementation.

---

## 13. Testing strategy

### 13.1 Unit tests

Must cover:

- URL joining and `/api/v1` handling.
- Authorization header construction.
- arbitrary configured custom headers.
- SecretRef-resolved values never appear in tool output/log fixtures.
- timeouts/abort handling.
- validation of allowed rule actions.
- rejection of forbidden rule actions.
- pending ownership-marker parsing.
- confirm/reject refuses ordinary rules.
- confirm activates exactly the existing pending rule rather than accepting rewritten content.

### 13.2 Integration tests

Run against a disposable/test Firefly instance matching or close to production version.

Required lifecycle test:

```text
Create test transactions
        ↓
create pending inactive rule
        ↓
verify rule remains inactive
        ↓
GET /rules/{id}
        ↓
plugin compiles persisted triggers
        ↓
GET /search/transactions
        ↓
verify expected match set
        ↓
update pending rule
        ↓
retest
        ↓
confirm
        ↓
verify rule active
```

Separate rejection test:

```text
create pending rule
→ reject
→ verify rule no longer exists
```

Expiry test:

```text
create old pending rule fixture
→ cleanup
→ pending rule removed
→ normal inactive user rule preserved
```

### 13.3 Reverse-proxy header integration test

Provide a mock/proxy test server that rejects requests without configured security headers. Verify that the plugin supplies the required headers on every Firefly call.

### 13.4 Firefly version compatibility

At minimum, test against the deployed production Firefly version. CI should make the Firefly version explicit rather than silently tracking `latest`.

Because the API schema can evolve, the repository should document which Firefly versions have been tested.

---

## 14. Security requirements

The implementation must meet all of the following:

- Firefly token stored using OpenClaw-supported secret handling.
- Additional auth/security headers may also be secret-backed.
- No model-controlled arbitrary destination URL.
- `baseUrl` is operator configuration only.
- No model-controlled arbitrary HTTP headers.
- No raw `firefly_http_request` tool.
- No generic transaction delete/update tool.
- No generic rule delete tool.
- No rule trigger/execution tool in v1.
- Pending-rule activation requires explicit user approval.
- Plugin-owned rule marker checked before update/confirm/reject.
- Rule actions enforced by code allowlist.
- Network errors and logs must redact secrets.

Recommended additional hardening:

- Restrict Firefly API exposure to LAN/VPN/reverse-proxy paths used by OpenClaw.
- Use a dedicated Firefly API credential if Firefly permission granularity permits.
- Pin package dependencies and enable automated dependency/security scanning.
- Treat OpenClaw plugin SDK upgrades as compatibility changes requiring CI.

---

## 15. Implementation phases

### Phase 1 - repository + read-only connectivity

Deliver:

- repo scaffold
- tool plugin builds/validates
- config schema
- secret-backed bearer token
- custom request headers
- transactions list/get/search
- categories list
- rules list/get
- rule groups list
- tests

Acceptance: OpenClaw can safely inspect Firefly through the security layer without exposing credentials.

### Phase 2 - pending-rule lifecycle

Deliver:

- create pending inactive rule
- preview the persisted rule using deterministic plugin-side translation to Firefly search syntax
- update pending rule
- confirm pending rule
- reject pending rule
- ownership markers
- safety allowlist
- integration tests

Acceptance: No ordinary Firefly rule can be changed/deleted through pending-only tools.

### Phase 3 - categorizer skill + Telegram workflow

Deliver:

- `firefly-categorizer/SKILL.md`
- historical pattern workflow
- proposal summary format
- edit/retest/confirm flow
- Finance topic setup documentation

Acceptance: Agent can propose a rule, show actual Firefly test matches in Telegram, and activate only after explicit approval.

### Phase 4 - 24-hour expiry

Deliver:

- safe pending-rule cleanup mechanism
- schedule/configuration
- logging
- expiry tests

Acceptance: stale plugin-owned pending rules are deleted after 24h while unrelated Firefly rules are untouched.

### Phase 5 - optional improvements

Potential later additions:

- one-off `set_category` tool for transactions where no permanent rule is appropriate
- `add_tag` rule action
- rule-expression validation
- richer Telegram inline approval buttons
- detection of overlapping existing rules
- dashboard/metrics for proposal acceptance rates
- optional category suggestion confidence reporting

---

## 16. Definition of done

The initial project is complete when:

1. It installs as a normal OpenClaw tool plugin.
2. It runs on the documented current OpenClaw Node/TypeScript plugin requirements.
3. It connects to Firefly III v6.7.2 or the operator's explicitly pinned compatible version.
4. It supports bearer authentication plus arbitrary configured custom headers.
5. Secrets are not placed in source, prompts, normal logs, or tool results.
6. The agent can list/search transactions, categories, rules, and rule groups.
7. The agent can create an inactive pending categorization rule.
8. The persisted Firefly rule is deterministically translated inside the plugin to the same search syntax used by Firefly's web preview; the model never performs this translation.
9. The pending rule can be edited and retested.
10. Confirmation activates only the exact existing pending rule after explicit user approval.
11. Rejection deletes only an OpenClaw-owned pending rule.
12. Unconfirmed pending rules expire after 24 hours.
13. Generic destructive Firefly capabilities are not exposed.
14. Automated tests cover rule safety and the full pending lifecycle.
15. `README.md` contains install/configuration examples without real credentials.

---

## 17. Implementation notes for the coding agent

Before coding the Firefly models, fetch or inspect the **current Firefly III v6.7.2 OpenAPI definition/source** and confirm:

- exact `RuleStore` and `RuleUpdate` field names;
- exact representation of `active`;
- exact trigger/action keyword enums;
- appropriate field for plugin pending/ownership metadata;
- rule group requirements when creating a rule;
- pagination and search query semantics;
- Firefly's persisted-rule-to-search translation, search aliases, and native rule-test quirks;
- media types expected by Firefly (`application/json` vs `application/vnd.api+json` where relevant).

Do not blindly copy old generated client schemas. Use the current running version as the compatibility target.

For OpenClaw, confirm the installed gateway version before development and scaffold using the current CLI:

```bash
openclaw plugins init openclaw-firefly --name "Firefly III"
```

Then use the current documented build/validation flow, e.g.:

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

Pin the minimum supported OpenClaw version in `package.json`/documentation.

---

## 18. References used for this specification

- OpenClaw Tool Plugins: https://docs.openclaw.ai/plugins/tool-plugins
- OpenClaw `defineToolPlugin`: https://docs.openclaw.ai/plugins/sdk-entrypoints/define-tool-plugin
- OpenClaw SecretRef contract: https://docs.openclaw.ai/gateway/secrets/secretref-contract
- OpenClaw Telegram threads/topics: https://docs.openclaw.ai/channels/telegram/threads-and-sessions
- Firefly III releases: https://github.com/firefly-iii/firefly-iii/releases
- Firefly III generated API/client endpoint inventory: https://github.com/ms32035/firefly-iii-client
- Firefly III API documentation gap discussion/current route confirmation: https://github.com/orgs/firefly-iii/discussions/12380

---

## 19. Recommended first implementation decision

Create the Git repository now and treat this document as `docs/TECHNICAL_SPEC.md`. Have the coding agent implement **Phase 1 and Phase 2 first**, without building the categorizer skill yet. Once the plugin safely connects through the existing security layers and the pending-rule/test/confirm lifecycle works against the real Firefly instance, add the skill and Telegram workflow.

This sequencing makes the hard security and API assumptions testable before introducing agent reasoning.
