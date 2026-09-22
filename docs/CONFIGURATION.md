# Configuration

## Plugin fields

| Field | Required | Default | Notes |
|---|---:|---:|---|
| `baseUrl` | yes | — | Operator-controlled Firefly URL. The plugin appends `/api/v1` when absent. URL credentials and fragments are rejected. |
| `accessToken` | yes | — | Firefly bearer token. Use an OpenClaw SecretRef. |
| `headers` | no | `{}` | Operator-controlled headers sent on every request. Values may be literals or SecretRefs. |
| `requestTimeoutMs` | no | `10000` | 100–120000 ms, including response-body consumption. |
| `maxResponseBytes` | no | `5242880` | 1024–10485760 bytes. Oversized bodies are cancelled before parsing. |
| `allowInsecureHttp` | no | `false` | Permit HTTP only for a trusted local/test deployment. HTTPS is the default. |

Neither destination URLs nor per-request headers are model tool parameters.

## SecretRefs

The manifest declares `accessToken` and `headers.*` as secret-input paths. Supported OpenClaw SecretRef sources are `env`, `file`, `exec`, and `store`:

```json5
{ source: "store", provider: "default", id: "FIREFLY_ACCESS_TOKEN" }
```

Do not put real values in this repository, examples, shell history, or reports. If a SecretRef cannot be resolved, the plugin rejects the configuration defensively.

## Upgrade from the pending-rule release

Before starting this version, remove `allowBestEffortPendingRuleDeletion` from the installed plugin configuration. The option has been removed; leaving it in the strict schema can prevent startup.

Then rebuild the installed artifact and restart the Gateway. For a path installation:

```sh
git pull --ff-only
npm ci
npm run build
openclaw gateway restart
```

Make a read-only Firefly call after restart before approving mutations. Do not treat a source pull without rebuilding `dist/` as an upgrade.

Existing rules do not need recreation. First-line legacy OpenClaw `pending:v1` and `confirmed:v1` markers are recognized as managed; their old proposal metadata is ignored. A requested update, activation, or actual state change rewrites the marker as `managed:v1`.

## Base URL examples

| Input | API root |
|---|---|
| `https://firefly.example.com` | `https://firefly.example.com/api/v1/` |
| `https://firefly.example.com/api` | `https://firefly.example.com/api/v1/` |
| `https://firefly.example.com/api/v1` | unchanged |
| `https://example.com/firefly` | `https://example.com/firefly/api/v1/` |

## Reverse proxies

Cloudflare Access or similar headers belong in static plugin configuration, never in tool calls. A mock integration test verifies that configured headers are sent on every request.

## Live v6.7.2 integration profile

`tests/integration/firefly-v672-live.test.ts` is opt-in. It requires `FIREFLY_LIVE_ALLOW_DESTRUCTIVE=1` and the documented live-test variables, an exact `/about` version of `6.7.2`, and a disposable server/token. It must not target production rules. The test creates and mutates disposable rules during teardown; mocked integration coverage exercises the remaining contracts.
