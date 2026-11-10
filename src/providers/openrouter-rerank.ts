import type { AppConfig } from "../config.js";
import { ProviderError, normalizeProviderError } from "../errors.js";
import {
  normalizeRerankModelId,
  resolveRerankTimeoutMs,
} from "../rerank-calibration.js";
import type { Reranker, RerankResult, SearchSource } from "../types.js";
import { OpenRouterClient } from "./openrouter-client.js";
import type { OpenRouterCallResult } from "./openrouter-client.js";

interface OpenRouterRerankResponse {
  model?: string;
  results?: Array<{
    index?: number;
    relevance_score?: number;
  }>;
}

const RERANK_PATH = "/api/v1/rerank";
const RERANK_CIRCUIT_FAILURES = 3;
const RERANK_CIRCUIT_COOLDOWN_MS = 60_000;

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

function mapRerankSources(
  payload: OpenRouterRerankResponse,
  sources: SearchSource[],
): SearchSource[] {
  const ranked: SearchSource[] = [];
  const seen = new Set<number>();
  const responseItems = [...(payload.results ?? [])].sort(
    (left, right) =>
      (right.relevance_score ?? Number.NEGATIVE_INFINITY)
      - (left.relevance_score ?? Number.NEGATIVE_INFINITY),
  );
  for (const item of responseItems) {
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
  return ranked;
}

export class OpenRouterReranker implements Reranker {
  readonly id = "openrouter-rerank" as const;

  private readonly client: OpenRouterClient;

  constructor(
    private readonly config: AppConfig,
    client?: OpenRouterClient,
  ) {
    this.client = client ?? new OpenRouterClient(config);
  }

  private assertCredential(): void {
    if (this.config.openRouterApiKey === undefined) {
      throw new ProviderError(
        this.id,
        "missing_credential",
        "OPENROUTER_API_KEY is not configured",
      );
    }
  }

  private async call(
    model: string,
    query: string,
    sources: SearchSource[],
    signal: AbortSignal | undefined,
  ): Promise<OpenRouterCallResult<OpenRouterRerankResponse>> {
    return this.client.post<OpenRouterRerankResponse>(
      this.id,
      RERANK_PATH,
      {
        model,
        query,
        documents: sources.map((source) => ({
          text: documentText(source, this.config.rerankInputChars),
        })),
        top_n: sources.length,
      },
      {
        timeoutMs: resolveRerankTimeoutMs(model, this.config.openRouterRerankTimeoutMs),
        ...(signal === undefined ? {} : { signal }),
        circuitFailures: RERANK_CIRCUIT_FAILURES,
        circuitCooldownMs: RERANK_CIRCUIT_COOLDOWN_MS,
      },
    );
  }

  /** One fallback retry, only when the primary model itself is unavailable. */
  private fallbackModel(requestedModel: string, error: unknown): string | undefined {
    const fallback = this.config.openRouterRerankFallbackModel;
    if (fallback === undefined) return undefined;
    if (!(error instanceof ProviderError) || error.status !== 404) return undefined;
    if (
      normalizeRerankModelId(fallback)
      === normalizeRerankModelId(requestedModel)
    ) {
      return undefined;
    }
    return fallback;
  }

  async rerank(
    query: string,
    sources: SearchSource[],
    signal?: AbortSignal,
    options?: { model?: string },
  ): Promise<RerankResult> {
    this.assertCredential();
    const requestedModel = options?.model ?? this.config.openRouterRerankModel;
    if (sources.length === 0) {
      return {
        sources: [],
        model: requestedModel,
        elapsedMs: 0,
        inputCount: 0,
      };
    }
    const started = performance.now();
    try {
      let usedModel = requestedModel;
      let call: OpenRouterCallResult<OpenRouterRerankResponse>;
      try {
        call = await this.call(usedModel, query, sources, signal);
      } catch (error) {
        const fallbackModel = this.fallbackModel(usedModel, error);
        if (fallbackModel === undefined) throw error;
        usedModel = fallbackModel;
        call = await this.call(usedModel, query, sources, signal);
      }
      return {
        sources: mapRerankSources(call.data, sources),
        model: call.data.model ?? usedModel,
        elapsedMs: Math.round(performance.now() - started),
        inputCount: sources.length,
        ...(call.usage === undefined ? {} : { usage: call.usage }),
      };
    } catch (error) {
      throw normalizeProviderError(this.id, error);
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
      signal,
    );
    return result.sources.length;
  }
}
