import type { AppConfig } from "../config.js";
import {
  ProviderError,
  classifyHttpStatus,
  errorText,
  normalizeProviderError,
} from "../errors.js";
import { withTimeout } from "../utils.js";
import { SERVER_VERSION } from "../version.js";

export type OpenRouterProviderId =
  | "openrouter-rerank"
  | "openrouter-embed"
  | "openrouter-decisions";

export interface OpenRouterCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Circuit-breaker failure threshold for this provider (default 3). */
  circuitFailures?: number;
  /** Circuit-breaker cooldown in milliseconds (default 60_000). */
  circuitCooldownMs?: number;
}

export interface OpenRouterCallResult<T> {
  data: T;
  status: number;
  elapsedMs: number;
  usage?: Record<string, unknown>;
}

interface BreakerState {
  failures: number;
  openedAt?: number;
}

const DEFAULT_ENDPOINT = "https://openrouter.ai";

function usageOf(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const usage = (data as Record<string, unknown>).usage;
  return typeof usage === "object" && usage !== null
    ? (usage as Record<string, unknown>)
    : undefined;
}

function errorDetail(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } | string };
    const message = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.error?.message === "string"
        ? parsed.error.message
        : undefined;
    if (message !== undefined && message.length > 0) return `: ${message.slice(0, 300)}`;
  } catch {
    // Fall through to the raw excerpt.
  }
  return `: ${trimmed.slice(0, 300)}`;
}

/**
 * Shared OpenRouter transport: API key, concurrency, per-minute request cap,
 * timeout, per-provider circuit breaker and usage passthrough.
 *
 * Callers own endpoint paths (`/api/v1/rerank`, `/api/v1/embeddings`,
 * `/api/alpha/decisions`) and model-specific request bodies.
 */
export class OpenRouterClient {
  private readonly breakers = new Map<OpenRouterProviderId, BreakerState>();
  private readonly callTimestamps: number[] = [];
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly endpoint = DEFAULT_ENDPOINT,
  ) {}

  private apiKey(): string {
    if (this.config.openRouterApiKey === undefined) {
      throw new ProviderError(
        "openrouter-rerank",
        "missing_credential",
        "OPENROUTER_API_KEY is not configured",
      );
    }
    return this.config.openRouterApiKey;
  }

  isCircuitOpen(provider: OpenRouterProviderId, cooldownMs = 60_000): boolean {
    const breaker = this.breakers.get(provider);
    if (breaker?.openedAt === undefined) return false;
    if (Date.now() - breaker.openedAt >= cooldownMs) {
      // Half-open: allow one probe.
      this.breakers.set(provider, { failures: 0 });
      return false;
    }
    return true;
  }

  private assertCircuit(provider: OpenRouterProviderId, options: OpenRouterCallOptions): void {
    if (this.isCircuitOpen(provider, options.circuitCooldownMs ?? 60_000)) {
      throw new ProviderError(
        provider,
        "network_error",
        `${provider} circuit breaker is open; skipping the call`,
        { retryable: false },
      );
    }
  }

  private recordSuccess(provider: OpenRouterProviderId): void {
    this.breakers.set(provider, { failures: 0 });
  }

  private recordFailure(provider: OpenRouterProviderId, options: OpenRouterCallOptions): void {
    const breaker = this.breakers.get(provider) ?? { failures: 0 };
    const failures = breaker.failures + 1;
    const threshold = options.circuitFailures ?? 3;
    this.breakers.set(provider, failures >= threshold
      ? { failures, openedAt: Date.now() }
      : { failures });
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.config.openRouterMaxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    const now = Date.now();
    const windowStart = now - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0]! < windowStart) {
      this.callTimestamps.shift();
    }
    if (this.callTimestamps.length >= this.config.openRouterMaxCallsPerMinute) {
      const waitMs = this.callTimestamps[0]! + 60_000 - now;
      this.release();
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      return this.acquire();
    }
    this.callTimestamps.push(now);
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
  }

  async post<T>(
    provider: OpenRouterProviderId,
    path: string,
    body: unknown,
    options: OpenRouterCallOptions,
  ): Promise<OpenRouterCallResult<T>> {
    const apiKey = this.apiKey();
    this.assertCircuit(provider, options);
    await this.acquire();
    const started = performance.now();
    try {
      const data = await withTimeout(
        async (requestSignal) => {
          let response: Response;
          try {
            response = await fetch(`${this.endpoint}${path}`, {
              method: "POST",
              redirect: "error",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
                "user-agent": `deepseek-web-search-mcp/${SERVER_VERSION}`,
              },
              body: JSON.stringify(body),
              signal: requestSignal,
            });
          } catch (error) {
            if (requestSignal.aborted) throw error;
            throw new ProviderError(
              provider,
              "network_error",
              `${provider} request failed: ${errorText(error)}`,
              { retryable: true, cause: error },
            );
          }
          let text: string;
          try {
            text = await response.text();
          } catch (error) {
            if (requestSignal.aborted) throw error;
            throw new ProviderError(
              provider,
              "network_error",
              `${provider} response body could not be read: ${errorText(error)}`,
              { retryable: true, cause: error },
            );
          }
          if (!response.ok) {
            throw new ProviderError(
              provider,
              classifyHttpStatus(response.status),
              `${provider} HTTP ${response.status}${errorDetail(text)}`,
              {
                status: response.status,
                retryable: response.status === 429 || response.status >= 500,
              },
            );
          }
          try {
            return JSON.parse(text) as T;
          } catch (error) {
            throw new ProviderError(
              provider,
              "invalid_response",
              `${provider} returned a non-JSON body: ${errorText(error)}`,
              { cause: error },
            );
          }
        },
        options.timeoutMs,
        `OpenRouter ${provider}`,
        options.signal,
      );
      this.recordSuccess(provider);
      const result: OpenRouterCallResult<T> = {
        data,
        status: 200,
        elapsedMs: Math.round(performance.now() - started),
      };
      const usage = usageOf(data);
      if (usage !== undefined) result.usage = usage;
      return result;
    } catch (error) {
      const normalized = normalizeProviderError(provider, error);
      this.recordFailure(provider, options);
      throw normalized;
    } finally {
      this.release();
    }
  }
}
