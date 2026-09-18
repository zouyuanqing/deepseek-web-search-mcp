import type { AppConfig } from "../config.js";
import { ProviderError, classifyHttpStatus, errorText, normalizeProviderError } from "../errors.js";
import type { Reranker, RerankResult, SearchSource } from "../types.js";
import { withTimeout } from "../utils.js";

interface OpenRouterRerankResponse {
  model?: string;
  results?: Array<{
    index?: number;
    relevance_score?: number;
  }>;
}

function documentText(source: SearchSource, maxChars: number): string {
  return [
    source.title,
    source.snippet,
    source.url,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .slice(0, maxChars);
}

export class OpenRouterReranker implements Reranker {
  readonly id = "openrouter-rerank" as const;

  constructor(
    private readonly config: AppConfig,
    private readonly endpoint = "https://openrouter.ai/api/v1/rerank",
  ) {}

  private apiKey(): string {
    if (this.config.openRouterApiKey === undefined) {
      throw new ProviderError(
        this.id,
        "missing_credential",
        "OPENROUTER_API_KEY is not configured",
      );
    }
    return this.config.openRouterApiKey;
  }

  async rerank(
    query: string,
    sources: SearchSource[],
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<RerankResult> {
    const apiKey = this.apiKey();
    if (sources.length === 0) {
      return {
        sources: [],
        model: this.config.openRouterRerankModel,
        elapsedMs: 0,
        inputCount: 0,
      };
    }
    const started = performance.now();
    try {
      return await withTimeout(
        async (requestSignal) => {
          const response = await fetch(this.endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-OpenRouter-Title": "DeepSeek Web Search MCP",
            },
            body: JSON.stringify({
              model: this.config.openRouterRerankModel,
              query,
              documents: sources.map((source) => ({
                text: documentText(source, this.config.rerankInputChars),
              })),
              top_n: Math.min(maxResults, sources.length),
            }),
            signal: requestSignal,
          });
          if (!response.ok) {
            throw new ProviderError(
              this.id,
              classifyHttpStatus(response.status),
              `OpenRouter rerank returned HTTP ${response.status}`,
              { status: response.status, retryable: response.status === 429 || response.status >= 500 },
            );
          }
          const payload = (await response.json()) as OpenRouterRerankResponse;
          const ranked: SearchSource[] = [];
          const seen = new Set<number>();
          for (const item of payload.results ?? []) {
            if (
              typeof item.index !== "number"
              || !Number.isInteger(item.index)
              || item.index < 0
              || item.index >= sources.length
              || seen.has(item.index)
            ) {
              continue;
            }
            const source = sources[item.index];
            if (source === undefined) continue;
            seen.add(item.index);
            ranked.push({
              ...source,
              ...(typeof item.relevance_score === "number"
                ? { rerankScore: item.relevance_score }
                : {}),
            });
          }
          for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            if (source !== undefined && !seen.has(index)) ranked.push(source);
          }
          if (ranked.length === 0) {
            throw new ProviderError(
              this.id,
              "invalid_response",
              "OpenRouter rerank returned no valid result indices",
            );
          }
          return {
            sources: ranked.slice(0, maxResults),
            model: payload.model ?? this.config.openRouterRerankModel,
            elapsedMs: Math.round(performance.now() - started),
            inputCount: sources.length,
          };
        },
        this.config.openRouterRerankTimeoutMs,
        "OpenRouter rerank",
        signal,
      );
    } catch (error) {
      throw normalizeProviderError(this.id, new Error(errorText(error)));
    }
  }

  async health(signal?: AbortSignal): Promise<number> {
    const result = await this.rerank(
      "DeepSeek API web search",
      [
        {
          provider: "tavily",
          url: "https://api-docs.deepseek.com/guides/anthropic_api",
          title: "DeepSeek Anthropic API",
          snippet: "Anthropic-compatible endpoint and server tools.",
        },
        {
          provider: "tavily",
          url: "https://example.com/unrelated",
          title: "Unrelated page",
          snippet: "An unrelated example.",
        },
      ],
      2,
      signal,
    );
    return result.sources.length;
  }
}
