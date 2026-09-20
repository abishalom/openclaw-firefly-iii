# Configuration

## Plugin fields

| Field | Required | Default | Notes |
|---|---:|---:|---|
| `baseUrl` | yes | — | Operator-controlled Firefly URL. The plugin appends `/api/v1` if absent. URL credentials and fragments are rejected. |
| `accessToken` | yes | — | Firefly bearer token. Use an OpenClaw SecretRef. |
| `headers` | no | `{}` | Operator-controlled headers added to every request. Every value is a declared secret-input path and may be a literal or SecretRef in source config. |
| `requestTimeoutMs` | no | `10000` | 100–120000 ms, including response body consumption. |
| `maxResponseBytes` | no | `5242880` | 1024–10485760 bytes. Bodies exceeding this limit are cancelled before parsing; this bounds memory used by large preview/search responses. |
| `allowInsecureHttp` | no | `false` | Allows HTTP only when explicitly enabled for a trusted local/test deployment. |
| `allowBestEffortPendingRuleDeletion` | no | `false` | Enables rejection DELETE only where no external rule writers exist; Firefly v6.7.2 has no conditional DELETE. |

Neither destination URLs nor per-request headers are exposed as model tool parameters.

## SecretRefs

The manifest registers these paths under `configContracts.secretInputs`:

- `accessToken`
- `headers.*`

Supported OpenClaw SecretRef sources are `env`, `file`, `exec`, and `store`:

```json5
{ source: "store", provider: "default", id: "FIREFLY_ACCESS_TOKEN" }
```

Do not put real token values in this repository, examples, shell history, or issue reports. If a SecretRef cannot be resolved, OpenClaw keeps this plugin capability cold; the plugin also rejects non-string unresolved values defensively.

### Migrate an existing `.env` token to the shared secret store

Run the first command interactively and paste the token into its masked prompt. Do not use `--value` for a secret:

```sh
openclaw secrets store set FIREFLY_ACCESS_TOKEN
openclaw config set plugins.entries.openclaw-firefly.config.accessToken '{"source":"store","provider":"default","id":"FIREFLY_ACCESS_TOKEN"}' --strict-json
openclaw secrets reload
openclaw secrets audit --check
```

Verify one read-only Firefly tool call, then remove `FIREFLY_ACCESS_TOKEN` from the Gateway `.env` and run `openclaw secrets audit --check` again. The stored value is not available to ordinary agent shell commands; OpenClaw resolves it only for the declared plugin secret-input path.

## Base URL examples

These normalize as follows:

| Input | API root |
|---|---|
| `https://firefly.example.com` | `https://firefly.example.com/api/v1/` |
| `https://firefly.example.com/api` | `https://firefly.example.com/api/v1/` |
| `https://firefly.example.com/api/v1` | unchanged |
| `https://example.com/firefly` | `https://example.com/firefly/api/v1/` |

## Reverse proxies

Cloudflare Access or similar headers belong in static plugin configuration, never in tool calls. A mock integration test verifies configured security headers are sent on every request.

## Live v6.7.2 integration profile

`tests/integration/firefly-v672-live.test.ts` is skipped unless `FIREFLY_LIVE_ALLOW_DESTRUCTIVE=1` and all of `FIREFLY_LIVE_BASE_URL`, `FIREFLY_LIVE_ACCESS_TOKEN`, `FIREFLY_LIVE_CATEGORY`, and `FIREFLY_LIVE_RULE_GROUP_ID` are set. It requires `/about` to report exactly `6.7.2`; use a disposable server and token only. The test creates, activates, rejects, and directly deletes rules during teardown. It does not currently cover direct account/category/tag creation or historical trigger execution; mocked integration coverage exercises those contracts, not a live Firefly deployment.

## Installation

Build/package on a development machine or CI runner, then install the resulting package into the OpenClaw gateway using that gateway's normal plugin installation flow. A global OpenClaw installation is not required in this repository; npm scripts use the pinned local development dependency. A path-installed checkout must run `npm ci && npm run build` after pulling because `dist/` is generated and intentionally not committed.
