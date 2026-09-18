import type { AppConfig } from "./config.js";
import { ProviderError, errorText } from "./errors.js";
import { DeepSeekNativeSearchProvider } from "./providers/deepseek-native.js";
import { AnySearchProvider } from "./providers/anysearch.js";
import { OpenRouterReranker } from "./providers/openrouter-rerank.js";
import { TavilySearchProvider } from "./providers/tavily.js";
import { SearxngProvider } from "./providers/searxng.js";
import type {
  DeepSeekNativeProvider,
  HealthReport,
  ProviderAttempt,
  ResearchInput,
  ResearchResult,
  Reranker,
  SearchInput,
  SearchProvider,
  SearchProviderId,
  SearchResult,
  SearchSource,
} from "./types.js";
import { dedupeSources, resolveScope } from "./utils.js";

export type ProviderRegistry = Record<SearchProviderId, SearchProvider>;

export function providerOrder(scope: "cn" | "global"): SearchProviderId[] {
  return scope === "cn"
    ? ["anysearch", "searxng", "tavily"]
    : ["tavily", "searxng", "anysearch"];
}

export function buildProviderRegistry(config: AppConfig): ProviderRegistry {
  return {
    anysearch: new AnySearchProvider(config),
    tavily: new TavilySearchProvider(config),
    searxng: new SearxngProvider(config),
  };
}

export class SearchService {
  private readonly nativeProvider: DeepSeekNativeProvider;
  private readonly reranker: Reranker;

  constructor(
    private readonly config: AppConfig,
    private readonly providers: ProviderRegistry = buildProviderRegistry(config),
    nativeProvider?: DeepSeekNativeProvider,
    reranker?: Reranker,
  ) {
    this.nativeProvider = nativeProvider ?? new DeepSeekNativeSearchProvider(config);
    this.reranker = reranker ?? new OpenRouterReranker(config);
  }

  async webSearch(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    return input.rerank
      ? this.webSearchReranked(input, signal)
      : this.webSearchFallback(input, signal);
  }

  private async webSearchFallback(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const attempts: ProviderAttempt[] = [];
    const warnings: string[] = [];
    let lastError: unknown;

    for (const providerId of providerOrder(scope)) {
      const provider = this.providers[providerId];
      const started = performance.now();
      try {
        const result = await provider.search(input, signal);
        const elapsedMs = Math.round(performance.now() - started);
        if (result.sources.length === 0) {
          attempts.push({ provider: providerId, status: "empty", elapsedMs });
          warnings.push(`${providerId} returned no results`);
          continue;
        }
        attempts.push({ provider: providerId, status: "ok", elapsedMs });
        warnings.push(...result.warnings);
        return {
          query: input.query,
          scope,
          mode: "fast",
          provider: providerId,
          fallbackUsed: attempts.length > 1,
          attempts,
          sources: result.sources.slice(0, input.maxResults),
          ...(result.answer === undefined ? {} : { answer: result.answer }),
          warnings,
        };
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - started);
        lastError = error;
        const providerError = error instanceof ProviderError
          ? error
          : new ProviderError(providerId, "unknown", errorText(error), { cause: error });
        attempts.push({
          provider: providerId,
          status: "error",
          elapsedMs,
          errorCode: providerError.code,
          errorMessage: providerError.message,
        });
        warnings.push(`${providerId} failed: ${providerError.message}`);
      }
    }

    throw new ProviderError(
      "service",
      "no_results",
      `All search providers failed for query "${input.query}"`,
      { cause: lastError },
    );
  }

  private async webSearchReranked(
    input: SearchInput,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const order = providerOrder(scope);
    const candidateInput: SearchInput = {
      ...input,
      rerank: false,
      maxResults: Math.min(20, Math.max(input.maxResults, 10)),
    };
    const settled = await Promise.all(
      order.map(async (providerId) => {
        const started = performance.now();
        try {
          const result = await this.providers[providerId].search(candidateInput, signal);
          return { providerId, result, elapsedMs: Math.round(performance.now() - started) };
        } catch (error) {
          return {
            providerId,
            error: error instanceof ProviderError
              ? error
              : new ProviderError(providerId, "unknown", errorText(error), { cause: error }),
            elapsedMs: Math.round(performance.now() - started),
          };
        }
      }),
    );

    const attempts: ProviderAttempt[] = [];
    const warnings: string[] = [];
    const candidates: SearchSource[] = [];
    const answers: string[] = [];
    let successCount = 0;

    for (const item of settled) {
      if ("error" in item) {
        attempts.push({
          provider: item.providerId,
          status: "error",
          elapsedMs: item.elapsedMs,
          errorCode: item.error.code,
          errorMessage: item.error.message,
        });
        warnings.push(`${item.providerId} failed: ${item.error.message}`);
        continue;
      }
      if (item.result.sources.length === 0) {
        attempts.push({
          provider: item.providerId,
          status: "empty",
          elapsedMs: item.elapsedMs,
        });
        warnings.push(`${item.providerId} returned no results`);
        continue;
      }
      successCount += 1;
      attempts.push({
        provider: item.providerId,
        status: "ok",
        elapsedMs: item.elapsedMs,
      });
      candidates.push(...item.result.sources);
      warnings.push(...item.result.warnings);
      if (item.result.answer !== undefined && item.result.answer.length > 0) {
        answers.push(item.result.answer);
      }
    }

    const uniqueCandidates = dedupeSources(candidates).slice(0, this.config.rerankCandidateLimit);
    if (uniqueCandidates.length === 0) {
      throw new ProviderError(
        "service",
        "no_results",
        `All search providers failed for query "${input.query}"`,
      );
    }

    const base = {
      query: input.query,
      scope,
      mode: "reranked" as const,
      provider: successCount > 1 ? ("multiple" as const) : settled.find(
        (item) => "result" in item && item.result.sources.length > 0,
      )?.providerId ?? null,
      fallbackUsed: successCount < order.length,
      attempts,
      ...(answers[0] === undefined ? {} : { answer: answers[0] }),
      warnings,
    };

    if (uniqueCandidates.length <= input.maxResults) {
      return {
        ...base,
        sources: uniqueCandidates,
        rerank: {
          requested: true,
          applied: false,
          provider: this.reranker.id,
          inputCount: uniqueCandidates.length,
          reason: "candidate_count_not_larger_than_result_limit",
        },
      };
    }

    try {
      const reranked = await this.reranker.rerank(
        input.query,
        uniqueCandidates,
        input.maxResults,
        signal,
      );
      return {
        ...base,
        sources: reranked.sources,
        rerank: {
          requested: true,
          applied: true,
          provider: this.reranker.id,
          model: reranked.model,
          elapsedMs: reranked.elapsedMs,
          inputCount: reranked.inputCount,
        },
      };
    } catch (error) {
      const rerankError = error instanceof ProviderError
        ? error
        : new ProviderError(this.reranker.id, "unknown", errorText(error), { cause: error });
      warnings.push(`Rerank failed; returned provider order: ${rerankError.message}`);
      return {
        ...base,
        sources: uniqueCandidates.slice(0, input.maxResults),
        rerank: {
          requested: true,
          applied: false,
          provider: this.reranker.id,
          inputCount: uniqueCandidates.length,
          reason: rerankError.message,
        },
      };
    }
  }

  async webResearch(input: ResearchInput, signal?: AbortSignal): Promise<ResearchResult> {
    try {
      const native = await this.nativeProvider.research(input, signal);
      return {
        ...native,
        degraded: false,
      };
    } catch (error) {
      const nativeError = error instanceof ProviderError
        ? error
        : new ProviderError("deepseek-native", "unknown", errorText(error), { cause: error });
      const fallback = await this.webSearch(
        {
          query: input.query,
          scope: "auto",
          maxResults: input.maxSources,
          freshness: input.freshness,
          rerank: false,
        },
        signal,
      );
      return {
        query: input.query,
        provider: "deepseek-native",
        answerMarkdown: fallback.answer ?? "",
        sources: fallback.sources,
        nativeSearchRequests: 0,
        nativeSearchCalls: [],
        warnings: [
          `DeepSeek native search was unavailable: ${nativeError.message}`,
          "Returned external search sources without a native DeepSeek research answer.",
          ...fallback.warnings,
        ],
        degraded: true,
      };
    }
  }

  async health(signal?: AbortSignal): Promise<HealthReport> {
    const query = "2026-09-17 Shanghai weather";
    const input: SearchInput = {
      query,
      scope: "global",
      maxResults: 3,
      freshness: "day",
      rerank: false,
    };
    const providers: HealthReport["providers"] = {};

    const run = async (
      id: SearchProviderId | "deepseek-native" | "openrouter-rerank",
      operation: () => Promise<number>,
    ): Promise<void> => {
      const started = performance.now();
      try {
        const count = await operation();
        providers[id] = {
          ok: count > 0,
          elapsedMs: Math.round(performance.now() - started),
          detail: `${count} source(s)`,
        };
      } catch (error) {
        providers[id] = {
          ok: false,
          elapsedMs: Math.round(performance.now() - started),
          detail: errorText(error),
        };
      }
    };

    await Promise.all([
      run("deepseek-native", async () => {
        const result = await this.nativeProvider.research(
          { query, maxSources: 3, freshness: "day" },
          signal,
        );
        return result.sources.length;
      }),
      run("anysearch", async () => (await this.providers.anysearch.search(input, signal)).sources.length),
      run("tavily", async () => (await this.providers.tavily.search(input, signal)).sources.length),
      run("searxng", async () => (await this.providers.searxng.search(input, signal)).sources.length),
      run("openrouter-rerank", async () => this.reranker.health(signal)),
    ]);

    return {
      ok: Object.values(providers).some((provider) => provider.ok),
      checkedAt: new Date().toISOString(),
      providers,
    };
  }
}
