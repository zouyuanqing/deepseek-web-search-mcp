import type { SearchProviderId } from "./types.js";

export type ProviderErrorCode =
  | "missing_credential"
  | "auth_error"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "invalid_response"
  | "search_not_executed"
  | "no_results"
  | "unknown";

export class ProviderError extends Error {
  readonly provider: SearchProviderId | "deepseek-native" | "openrouter-rerank" | "service";
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    provider: ProviderError["provider"],
    code: ProviderErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/as_sk_[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/tvly-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]{8,}/gi, "Bearer [REDACTED_SECRET]");
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return redactSecrets(String(error));
}

export function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network_error";
  return "unknown";
}

export function normalizeProviderError(
  provider: ProviderError["provider"],
  error: unknown,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (
    error instanceof Error
    && (
      error.name === "TimeoutError"
      || error.name === "AbortError"
      || error.name === "APIConnectionTimeoutError"
    )
  ) {
    return new ProviderError(provider, "timeout", error.message, {
      retryable: true,
      cause: error,
    });
  }
  const message = errorText(error);
  return new ProviderError(provider, "unknown", message, { cause: error });
}
