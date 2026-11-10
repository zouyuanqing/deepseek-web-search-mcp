import type { AppConfig } from "../config.js";
import {
  ProviderError,
  errorText,
  normalizeProviderError,
} from "../errors.js";
import type { ProviderErrorCode } from "../errors.js";
import { freshnessCutoff } from "../freshness.js";
import type {
  Freshness,
  ProviderResult,
  SearchInput,
  SearchProvider,
  SearchSource,
} from "../types.js";
import { dedupeSources, normalizeWhitespace, withTimeout } from "../utils.js";
import { SERVER_VERSION } from "../version.js";

/** Maximum query length accepted by the official Search API. */
export const DEEPSEEK_SEARCH_MAX_QUERY_CHARS = 128;
/** Maximum result count accepted by the official Search API. */
export const DEEPSEEK_SEARCH_MAX_COUNT = 50;
const MAX_SNIPPET_CHARS = 800;
const USER_AGENT = `deepseek-web-search-mcp/${SERVER_VERSION}`;

interface DeepSeekSearchApiItem {
  rerank_score?: unknown;
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
  content?: unknown;
  site_name?: unknown;
  site_icon?: unknown;
  date?: unknown;
  authority?: unknown;
}

interface DeepSeekSearchApiResponse {
  results?: unknown;
  error?: { message?: unknown; type?: unknown; code?: unknown };
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function contentField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}\u2026`;
}

/**
 * Slice by Unicode code points so a 128-character API limit never splits a
 * surrogate pair (which would send an invalid lone surrogate to the API).
 */
function sliceCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as DeepSeekSearchApiResponse;
    const message = stringField(parsed.error?.message);
    if (message !== undefined) return `: ${message}`;
  } catch {
    // Fall through to the raw body excerpt.
  }
  const trimmed = body.trim();
  return trimmed.length === 0 ? "" : `: ${truncate(trimmed, 200)}`;
}

function httpErrorCode(status: number): ProviderErrorCode {
  if (status === 400 || status === 413) return "invalid_request";
  if (status === 402) return "insufficient_balance";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network_error";
  return "unknown";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Translate a freshness window into the Search API's server-side `after:`
 * operator. The API caps queries at 128 characters, so the operator wins over
 * the tail of the query; the truncation is reported instead of being silent.
 */
export function buildDeepSeekSearchQuery(
  query: string,
  freshness: Freshness,
  now = new Date(),
): { query: string; warnings: string[] } {
  const trimmed = normalizeWhitespace(query);
  const cutoff = freshnessCutoff(freshness, now);
  if (cutoff === undefined) {
    if (Array.from(trimmed).length <= DEEPSEEK_SEARCH_MAX_QUERY_CHARS) {
      return { query: trimmed, warnings: [] };
    }
    return {
      query: sliceCodePoints(trimmed, DEEPSEEK_SEARCH_MAX_QUERY_CHARS),
      warnings: [
        `Query was truncated to the DeepSeek Search API limit of ${DEEPSEEK_SEARCH_MAX_QUERY_CHARS} characters.`,
      ],
    };
  }
  const operator = `after:${cutoff.toISOString().slice(0, 10)}`;
  const budget = DEEPSEEK_SEARCH_MAX_QUERY_CHARS - operator.length - 1;
  const base = Array.from(trimmed).length > budget
    ? sliceCodePoints(trimmed, Math.max(1, budget)).trimEnd()
    : trimmed;
  return {
    query: `${base} ${operator}`.trim(),
    warnings: Array.from(trimmed).length > budget
      ? [
        `Query was truncated to fit the DeepSeek Search API limit of ${DEEPSEEK_SEARCH_MAX_QUERY_CHARS} characters including the ${operator} freshness operator.`,
      ]
      : [],
  };
}

/** Map official Search API result items to the MCP's normalized source shape. */
export function mapDeepSeekSearchResults(items: unknown[]): SearchSource[] {
  const sources: SearchSource[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as DeepSeekSearchApiItem;
    const url = stringField(record.url);
    if (url === undefined) continue;
    const title = stringField(record.title);
    const snippet = stringField(record.snippet) ?? stringField(record.summary);
    const publishedAt = stringField(record.date);
    const content = contentField(record.content);
    const score = finiteNumber(record.rerank_score);
    const authority = finiteNumber(record.authority);
    sources.push({
      url,
      provider: "deepseek-search",
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet: truncate(snippet, MAX_SNIPPET_CHARS) }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(content === undefined ? {} : { content }),
      ...(score === undefined ? {} : { score }),
      ...(authority === undefined ? {} : { authorityTier: Math.trunc(authority) }),
    });
  }
  return dedupeSources(sources);
}

/**
 * Official DeepSeek Search API provider: `POST /v1/tools/search`.
 *
 * This is a raw JSON search call (no model turn, no generated answer), billed
 * per successful request. The legacy Anthropic-compatible Messages path with the
 * `web_search_20250305` server tool stays available as the separate
 * `deepseek-native` provider.
 */
export class DeepSeekSearchProvider implements SearchProvider {
  readonly id = "deepseek-search" as const;

  constructor(private readonly config: AppConfig) {}

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const apiKey = this.config.deepseekApiKey;
    if (apiKey === undefined) {
      throw new ProviderError(
        this.id,
        "missing_credential",
        "DEEPSEEK_API_KEY is required for the DeepSeek Search API",
      );
    }
    if (normalizeWhitespace(input.query).length === 0) {
      throw new ProviderError(
        this.id,
        "invalid_request",
        "DeepSeek Search API query must contain at least one non-whitespace character",
      );
    }
    const built = buildDeepSeekSearchQuery(input.query, input.freshness);
    const endpoint = `${this.config.deepseekSearchApiBaseUrl.replace(/\/+$/u, "")}/tools/search`;
    const body = {
      query: built.query,
      count: Math.min(
        DEEPSEEK_SEARCH_MAX_COUNT,
        Math.max(1, Math.trunc(input.maxResults)),
      ),
      need_content: this.config.deepseekSearchNeedContent,
    };

    try {
      const payload = await withTimeout(
        async (requestSignal) => {
          let response: Response;
          try {
            response = await fetch(endpoint, {
              method: "POST",
              redirect: "error",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
                "user-agent": USER_AGENT,
              },
              body: JSON.stringify(body),
              signal: requestSignal,
            });
          } catch (error) {
            if (requestSignal.aborted) throw error;
            throw new ProviderError(
              this.id,
              "network_error",
              `DeepSeek Search API request failed: ${errorText(error)}`,
              { retryable: true, cause: error },
            );
          }
          let text: string;
          try {
            text = await response.text();
          } catch (error) {
            if (requestSignal.aborted) throw error;
            throw new ProviderError(
              this.id,
              "network_error",
              `DeepSeek Search API response body could not be read: ${errorText(error)}`,
              { retryable: true, cause: error },
            );
          }
          if (!response.ok) {
            throw new ProviderError(
              this.id,
              httpErrorCode(response.status),
              `DeepSeek Search API error (HTTP ${response.status})${errorDetail(text)}`,
              { status: response.status, retryable: retryableStatus(response.status) },
            );
          }
          try {
            return JSON.parse(text) as DeepSeekSearchApiResponse;
          } catch (error) {
            throw new ProviderError(
              this.id,
              "invalid_response",
              `DeepSeek Search API returned a non-JSON response body: ${errorText(error)}`,
              { cause: error },
            );
          }
        },
        this.config.deepseekSearchApiTimeoutMs,
        "DeepSeek Search API request",
        signal,
      );

      if (typeof payload !== "object" || payload === null || !Array.isArray(payload.results)) {
        throw new ProviderError(
          this.id,
          "invalid_response",
          "DeepSeek Search API response is missing a results array",
        );
      }
      return {
        provider: this.id,
        sources: mapDeepSeekSearchResults(payload.results),
        warnings: built.warnings,
      };
    } catch (error) {
      throw normalizeProviderError(this.id, error);
    }
  }
}
