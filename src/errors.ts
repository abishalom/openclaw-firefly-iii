export type FireflyErrorCode =
  | "FIREFLY_CONFIG_INVALID"
  | "FIREFLY_AUTH_FAILED"
  | "FIREFLY_NOT_FOUND"
  | "FIREFLY_VALIDATION_FAILED"
  | "FIREFLY_RATE_LIMITED"
  | "FIREFLY_TEMPORARY_FAILURE"
  | "FIREFLY_TIMEOUT"
  | "FIREFLY_CANCELLED"
  | "FIREFLY_NETWORK_ERROR"
  | "FIREFLY_PROXY_DENIED"
  | "FIREFLY_INVALID_RESPONSE"
  | "FIREFLY_ACTIVATION_UNCERTAIN"
  | "FIREFLY_CREATION_UNCERTAIN"
  | "FIREFLY_RULE_EXECUTION_UNCERTAIN"
  | "FIREFLY_RULE_PREVIEW_REQUIRED"
  | "FIREFLY_RULE_PREVIEW_SCOPE_LIMITED"
  | "FIREFLY_RULE_PREVIEW_STALE"
  | "FIREFLY_RULE_NOT_PENDING"
  | "FIREFLY_RULE_UNSAFE";

export interface SafeFireflyError {
  code: FireflyErrorCode;
  message: string;
  status?: number;
}

export class FireflyError extends Error {
  readonly code: FireflyErrorCode;
  readonly status: number | undefined;

  constructor(code: FireflyErrorCode, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "FireflyError";
    this.code = code;
    this.status = status;
  }

  toJSON(): SafeFireflyError {
    return {
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

export function safeError(error: unknown): SafeFireflyError {
  if (error instanceof FireflyError) {
    return error.toJSON();
  }
  return {
    code: "FIREFLY_NETWORK_ERROR",
    message: "The Firefly request failed unexpectedly.",
  };
}

export function invalidResponse(message = "Firefly returned an unexpected response."): never {
  throw new FireflyError("FIREFLY_INVALID_RESPONSE", message);
}
