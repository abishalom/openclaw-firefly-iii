# openclaw-firefly

A narrow OpenClaw tool plugin for inspecting Firefly III and proposing category rules safely. It implements **Phase 1** and **Phase 2** of [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md).

The plugin can read transactions, categories, rules, and rule groups. Its only write workflow creates an inactive, marked rule; previews the persisted rule by translating its triggers to the same Firefly search syntax used by the web UI; then updates, confirms, or rejects only that marked pending rule.

## Safety boundaries

- New rules are forced inactive.
- Only the Firefly `set_category` action is accepted.
- The category must already exist in Firefly.
- Update, confirmation, and rejection verify an anchored marker and SHA-256 digest of the complete semantic proposal.
- Confirmation requires the reviewed `proposalDigest`, reasserts and verifies a complete inactive snapshot, then uses a minimal activation update. A failed or ambiguous activation is rolled back to inactive when ownership can still be verified; otherwise the tool reports `FIREFLY_ACTIVATION_UNCERTAIN` for operator inspection.
- Per-rule calls are serialized inside one Gateway process. Firefly v6.7.2 has no CAS or conditional DELETE, so external UI/other-process writers remain outside that lock.
- Rejection is disabled by default. Operators may explicitly enable best-effort pending deletion only under a no-external-rule-writers assumption; Firefly cannot atomically protect the check/delete interval.
- No transaction mutation/deletion, generic HTTP, generic rule deletion, or rule trigger endpoint is exposed.
- `firefly_rule_test` performs all preview translation inside the plugin: it fetches the persisted rule, compiles only reviewed trigger types, and searches Firefly. Unsupported triggers fail closed.
- No categorizer skill or Telegram workflow is included yet.

## Requirements

- Node.js 24.16+ or 26.1+
- OpenClaw >= 2026.5.17 on the target gateway
- Firefly III v6.7.2 (the verified target)
- A current Firefly Personal Access Token

OpenClaw does not need to be installed globally for development. `npm install` installs the pinned CLI/SDK as a development dependency, and npm scripts use that repository-local binary.

## Build and test

```sh
npm install
npm run build
npm test
npm run check # use Node 26.1+; invokes the repository-local OpenClaw CLI
```

`plugin:validate` needs a supported Node version because the local OpenClaw CLI enforces its Node floor.

## Configuration

Install the built package into the machine running OpenClaw, then configure its plugin entry. Use SecretRefs rather than plaintext credentials:

```json5
{
  secrets: {
    providers: {
      default: { source: "env", allowlist: ["FIREFLY_ACCESS_TOKEN", "FIREFLY_CF_CLIENT_ID", "FIREFLY_CF_CLIENT_SECRET"] }
    }
  },
  plugins: {
    entries: {
      "openclaw-firefly": {
        enabled: true,
        config: {
          baseUrl: "https://firefly.example.com",
          accessToken: { source: "env", provider: "default", id: "FIREFLY_ACCESS_TOKEN" },
          headers: {
            "CF-Access-Client-Id": { source: "env", provider: "default", id: "FIREFLY_CF_CLIENT_ID" },
            "CF-Access-Client-Secret": { source: "env", provider: "default", id: "FIREFLY_CF_CLIENT_SECRET" },
            "X-Environment": "home"
          },
          requestTimeoutMs: 10000,
          maxResponseBytes: 5242880
        }
      }
    }
  }
}
```

`openclaw.plugin.json` declares `accessToken` and every `headers.*` value as OpenClaw secret-input paths. OpenClaw resolves them before loading the plugin and redacts them in configuration projections. Plain HTTP is rejected unless an operator explicitly sets `allowInsecureHttp: true`; that option is intended only for trusted local/test networks.

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) and [`docs/SECURITY.md`](docs/SECURITY.md).

## Tools

Read only:

- `firefly_transactions_list`
- `firefly_transaction_get`
- `firefly_transactions_search`
- `firefly_categories_list`
- `firefly_rules_list`
- `firefly_rule_get`
- `firefly_rule_groups_list`
- `firefly_rule_test`

`firefly_rule_test` needs only a rule ID for normal use. Optional date/account filters and a result cap are applied by the plugin. The result includes the generated query (or ordered queries for a non-strict rule), normalized transaction matches, and a truncation indicator.

Constrained writes:

- `firefly_rule_create_pending`
- `firefly_rule_update_pending`
- `firefly_rule_confirm_pending`
- `firefly_rule_reject_pending`

## API compatibility

Schemas and behavior were checked against the Firefly III v6.7.2 tag and its versioned OpenAPI file before implementation. Details and known documentation/source differences are recorded in [`docs/API_COMPATIBILITY.md`](docs/API_COMPATIBILITY.md).

## Deferred phases

The categorizer skill, Telegram workflow, and scheduled 24-hour cleanup are deliberately not implemented. Pending markers include creation and expiry timestamps so Phase 4 can add cleanup without changing marker format.
