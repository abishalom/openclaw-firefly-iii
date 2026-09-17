import { Type, type Static } from "typebox";
import { FireflyError } from "./errors.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_RESPONSE_BYTES_LIMIT = 10 * 1024 * 1024;

export const fireflyConfigSchema = Type.Object(
  {
    baseUrl: Type.String({
      minLength: 1,
      description: "Operator-configured Firefly III URL. /api/v1 is appended when absent.",
    }),
    accessToken: Type.String({
      minLength: 1,
      description: "Firefly bearer token. Prefer an OpenClaw SecretRef; it is resolved before plugin startup.",
    }),
    headers: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.String(), {
        description: "Operator-controlled custom headers. Values may be OpenClaw SecretRefs.",
      }),
    ),
    requestTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: 120_000, default: 10_000 }),
    ),
    maxResponseBytes: Type.Optional(
      Type.Integer({
        minimum: 1024,
        maximum: MAX_RESPONSE_BYTES_LIMIT,
        default: DEFAULT_MAX_RESPONSE_BYTES,
        description: "Maximum Firefly response body size in bytes. Responses exceeding this limit are cancelled.",
      }),
    ),
    allowInsecureHttp: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Permit plain HTTP for trusted local/test deployments. HTTPS is required by default.",
      }),
    ),
    allowBestEffortPendingRuleDeletion: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Allow pending-rule deletion despite Firefly lacking conditional DELETE. Enable only when no external writers can modify rules.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type FireflyPluginConfig = Static<typeof fireflyConfigSchema>;

export interface NormalizedFireflyConfig {
  baseUrl: URL;
  accessToken: string;
  headers: Record<string, string>;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  allowBestEffortPendingRuleDeletion: boolean;
}

export function buildApiBaseUrl(value: string, allowInsecureHttp = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FireflyError("FIREFLY_CONFIG_INVALID", "Firefly baseUrl must be a valid URL.");
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new FireflyError(
      "FIREFLY_CONFIG_INVALID",
      "Firefly baseUrl must use HTTPS unless allowInsecureHttp is explicitly enabled.",
    );
  }
  if (url.username || url.password) {
    throw new FireflyError("FIREFLY_CONFIG_INVALID", "Firefly baseUrl must not contain credentials.");
  }
  url.hash = "";
  url.search = "";
  let path = url.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/api/v1")) {
    // Already an API root.
  } else if (path.endsWith("/api")) {
    path += "/v1";
  } else {
    path += "/api/v1";
  }
  url.pathname = `${path}/`;
  return url;
}

export function normalizeConfig(config: FireflyPluginConfig): NormalizedFireflyConfig {
  if (typeof config.accessToken !== "string" || config.accessToken.trim() === "") {
    throw new FireflyError(
      "FIREFLY_CONFIG_INVALID",
      "Firefly accessToken is missing or its SecretRef could not be resolved.",
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (typeof value !== "string") {
      throw new FireflyError(
        "FIREFLY_CONFIG_INVALID",
        `Configured Firefly header ${JSON.stringify(name)} could not be resolved.`,
      );
    }
    headers[name] = value;
  }
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1024 ||
    maxResponseBytes > MAX_RESPONSE_BYTES_LIMIT
  ) {
    throw new FireflyError(
      "FIREFLY_CONFIG_INVALID",
      `maxResponseBytes must be an integer between 1024 and ${MAX_RESPONSE_BYTES_LIMIT}.`,
    );
  }
  return {
    baseUrl: buildApiBaseUrl(config.baseUrl, config.allowInsecureHttp ?? false),
    accessToken: config.accessToken,
    headers,
    requestTimeoutMs: config.requestTimeoutMs ?? 10_000,
    maxResponseBytes,
    allowBestEffortPendingRuleDeletion: config.allowBestEffortPendingRuleDeletion ?? false,
  };
}
