import type { FireflyPluginConfig, NormalizedFireflyConfig } from "./config.js";
import { normalizeConfig } from "./config.js";
import { FireflyError } from "./errors.js";

export interface FireflyLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;

export interface FireflyRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

export class FireflyClient {
  readonly config: NormalizedFireflyConfig;
  readonly logger: FireflyLogger | undefined;

  constructor(config: FireflyPluginConfig, logger?: FireflyLogger) {
    this.config = normalizeConfig(config);
    this.logger = logger;
  }

  async get<T>(path: string, options: Omit<FireflyRequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  async post<T>(path: string, body: unknown, options: FireflyRequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  async put<T>(path: string, body: unknown, options: FireflyRequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  async delete(path: string, options: Omit<FireflyRequestOptions, "body"> = {}): Promise<void> {
    await this.request<undefined>("DELETE", path, options);
  }

  async request<T>(method: string, path: string, options: FireflyRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new FireflyError("FIREFLY_CONFIG_INVALID", "Firefly request path is invalid.");
    }
    const url = new URL(path.slice(1), this.config.baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(name, String(item));
      } else {
        url.searchParams.set(name, String(value));
      }
    }

    const headers = new Headers({
      Accept: "application/vnd.api+json, application/json",
      Authorization: `Bearer ${this.config.accessToken}`,
    });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(this.config.headers)) headers.set(name, value);

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.config.requestTimeoutMs);
    timeout.unref?.();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    const started = performance.now();
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal,
          redirect: "error",
        });
      } catch (error) {
        throw normalizeRequestFailure(error, options.signal, timeoutController.signal);
      }

      const durationMs = Math.round(performance.now() - started);
      this.logger?.debug?.(`Firefly ${method} ${url.pathname} -> ${response.status} (${durationMs}ms)`);

      if (!response.ok) {
        await discardResponse(response);
        throw mapHttpError(response.status);
      }
      if (response.status === 204) {
        await discardResponse(response);
        return undefined as T;
      }

      let text: string;
      try {
        text = await readResponseText(response, this.config.maxResponseBytes);
      } catch (error) {
        throw normalizeRequestFailure(error, options.signal, timeoutController.signal);
      }
      if (text.trim() === "") {
        throw new FireflyError("FIREFLY_INVALID_RESPONSE", "Firefly returned an empty response.");
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new FireflyError(
          "FIREFLY_INVALID_RESPONSE",
          "Firefly returned a non-JSON response.",
          response.status,
          { cause: error },
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeRequestFailure(
  error: unknown,
  requestSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): FireflyError {
  if (error instanceof FireflyError) return error;
  if (requestSignal?.aborted) {
    return new FireflyError("FIREFLY_CANCELLED", "The Firefly request was cancelled.", undefined, {
      cause: error,
    });
  }
  if (timeoutSignal.aborted) {
    return new FireflyError("FIREFLY_TIMEOUT", "The Firefly request timed out.", undefined, {
      cause: error,
    });
  }
  return new FireflyError(
    "FIREFLY_NETWORK_ERROR",
    "Could not reach the configured Firefly server.",
    undefined,
    { cause: error },
  );
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponse(response);
    throw new FireflyError(
      "FIREFLY_INVALID_RESPONSE",
      `Firefly response exceeded the ${maxBytes}-byte body limit.`,
      response.status,
    );
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let complete = false;
  try {
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return text + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new FireflyError(
          "FIREFLY_INVALID_RESPONSE",
          `Firefly response exceeded the ${maxBytes}-byte body limit.`,
          response.status,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // The original body-read failure is more useful than cancellation failure.
      }
    }
    reader.releaseLock();
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error bodies are deliberately not surfaced or logged: reverse proxies may include secrets.
  }
}

function mapHttpError(status: number): FireflyError {
  if (status === 401) {
    return new FireflyError("FIREFLY_AUTH_FAILED", "Firefly rejected the configured credentials.", status);
  }
  if (status === 403) {
    return new FireflyError(
      "FIREFLY_PROXY_DENIED",
      "Firefly or its security layer denied the request.",
      status,
    );
  }
  if (status === 404) {
    return new FireflyError("FIREFLY_NOT_FOUND", "The requested Firefly resource was not found.", status);
  }
  if (status === 422) {
    return new FireflyError(
      "FIREFLY_VALIDATION_FAILED",
      "Firefly rejected the request as invalid.",
      status,
    );
  }
  if (status === 429) {
    return new FireflyError("FIREFLY_RATE_LIMITED", "Firefly rate-limited the request.", status);
  }
  if (status >= 500) {
    return new FireflyError(
      "FIREFLY_TEMPORARY_FAILURE",
      "Firefly is temporarily unavailable.",
      status,
    );
  }
  return new FireflyError("FIREFLY_NETWORK_ERROR", "The Firefly request failed.", status);
}
