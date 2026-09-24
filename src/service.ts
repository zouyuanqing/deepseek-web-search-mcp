import { hashCacheKey, normalizeCacheQuery, TtlLruCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { ProviderError, errorText } from "./errors.js";
import { DeepSeekNativeSearchProvider } from "./providers/deepseek-native.js";
import { AnySearchProvider } from "./providers/anysearch.js";
import { OpenRouterReranker } from "./providers/openrouter-rerank.js";
import { TavilySearchProvider } from "./providers/tavily.js";
import { SearxngProvider } from "./providers/searxng.js";
import {
  candidateTarget,
  fuseRankings,
  providerRequestLimit,
  QUALITY_PROFILES,
  RANK_FUSION_WEIGHTS,
  resolveQuality,
  withoutRankingMetadata,
} from "./ranking.js";
import type {
  DeepSeekNativeProvider,
  HealthReport,
  ProviderAttempt,
  ProviderResult,
  Quality,
  ResearchInput,
  ResearchResult,
  Reranker,
  RerankResult,
  SearchInput,
  SearchProvider,
  SearchProviderId,
  SearchResult,
  SearchSource,
} from "./types.js";
import {
  applyFreshnessToQuery,
  canonicalizeUrl,
  dedupeSources,
  resolveScope,
} from "./utils.js";

export type ProviderRegistry = Record<SearchProviderId, SearchProvider>;

interface ProviderCall {
  result: ProviderResult;
  cached: boolean;
}

interface RerankCall {
  result: RerankResult;
  cached: boolean;
}

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

function cloneProviderResult(result: ProviderResult): ProviderResult {
  return {
    ...result,
    sources: result.sources.map((source) => ({ ...source })),
    warnings: [...result.warnings],
    ...(result.usage === undefined ? {} : { usage: { ...result.usage } }),
  };
}

function cloneRerankResult(result: RerankResult): RerankResult {
  return {
    ...result,
    sources: result.sources.map((source) => ({ ...source })),
  };
}

export class SearchService {
  private readonly nativeProvider: DeepSeekNativeProvider;
  private readonly reranker: Reranker;
  private readonly searchCache: TtlLruCache<string, ProviderResult>;
  private readonly rerankCache: TtlLruCache<string, RerankResult>;

  constructor(
    private readonly config: AppConfig,
    private readonly providers: ProviderRegistry = buildProviderRegistry(config),
    nativeProvider?: DeepSeekNativeProvider,
    reranker?: Reranker,
  ) {
    this.nativeProvider = nativeProvider ?? new DeepSeekNativeSearchProvider(config);
    this.reranker = reranker ?? new OpenRouterReranker(config);
    this.searchCache = new TtlLruCache({
      ttlMs: config.searchCacheTtlMs,
      maxEntries: config.searchCacheMaxEntries,
    });
    this.rerankCache = new TtlLruCache({
      ttlMs: config.rerankCacheTtlMs,
      maxEntries: config.rerankCacheMaxEntries,
    });
  }

  async webSearch(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    const quality = resolveQuality(input);
    const backend = input.backend ?? this.config.webSearchBackend ?? "external";
    if (backend === "deepseek-native") {
      return this.webSearchNative(input, quality, signal);
    }
    if (backend === "auto" && this.config.deepseekApiKey !== undefined) {
      return this.webSearchAutoNative(input, quality, signal);
    }
    return this.webSearchExternal(input, quality, signal);
  }

  private async webSearchExternal(
    input: SearchInput,
    quality: Quality,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    return QUALITY_PROFILES[quality].rerank
      ? this.webSearchRanked(input, quality, signal)
      : this.webSearchFast(input, quality, signal);
  }

  private async webSearchNative(
    input: SearchInput,
    quality: Quality,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const started = performance.now();
    try {
      const native = await this.nativeProvider.research(
        {
          query: applyFreshnessToQuery(input.query, input.freshness),
          maxSources: input.maxResults,
          freshness: input.freshness,
        },
        signal,
      );
      const elapsedMs = Math.round(performance.now() - started);
      const warnings = [...native.warnings];
      if (input.rerank === true || quality !== "fast") {
        warnings.push("The deepseek-native backend does not use external-provider rank fusion.");
      }
      return {
        query: input.query,
        scope: resolveScope(input.query, input.scope),
        mode: "native",
        quality,
        backend: "deepseek-native",
        provider: "deepseek-native",
        fallbackUsed: false,
        attempts: [{
          provider: "deepseek-native",
          status: "ok",
          elapsedMs,
        }],
        sources: native.sources.slice(0, input.maxResults),
        answer: native.answerMarkdown,
        warnings,
        nativeSearchRequests: native.nativeSearchRequests,
        nativeSearchCalls: native.nativeSearchCalls,
        nativeSearchDegraded: false,
      };
    } catch (error) {
      throw error instanceof ProviderError
        ? error
        : new ProviderError("deepseek-native", "unknown", errorText(error), { cause: error });
    }
  }

  private async webSearchAutoNative(
    input: SearchInput,
    quality: Quality,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    try {
      return await this.webSearchNative(input, quality, signal);
    } catch (error) {
      const nativeError = error instanceof ProviderError
        ? error
        : new ProviderError("deepseek-native", "unknown", errorText(error), { cause: error });
      try {
        const fallback = await this.webSearchExternal(input, quality, signal);
        return {
          ...fallback,
          backend: "external",
          fallbackUsed: true,
          warnings: [
            `DeepSeek native search was unavailable; used external providers: ${nativeError.message}`,
            ...fallback.warnings,
          ],
          nativeSearchRequests: 0,
          nativeSearchCalls: [],
          nativeSearchDegraded: true,
        };
      } catch (fallbackError) {
        const fallbackProviderError = fallbackError instanceof ProviderError
          ? fallbackError
          : new ProviderError("service", "unknown", errorText(fallbackError), { cause: fallbackError });
        throw new ProviderError(
          "service",
          "no_results",
          `DeepSeek native search failed (${nativeError.message}); external fallback failed (${fallbackProviderError.message})`,
          { cause: fallbackError },
        );
      }
    }
  }

  private async webSearchFast(
    input: SearchInput,
    quality: Quality,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const attempts: ProviderAttempt[] = [];
    const warnings: string[] = [];
    let lastError: unknown;
    const providerInput: SearchInput = {
      ...input,
      quality,
      rerank: false,
      maxResults: providerRequestLimit(quality, input.maxResults),
    };

    for (const providerId of providerOrder(scope)) {
      const started = performance.now();
      try {
        const call = await this.searchProvider(providerId, providerInput, scope, signal);
        const elapsedMs = Math.round(performance.now() - started);
        if (call.result.sources.length === 0) {
          attempts.push({
            provider: providerId,
            status: "empty",
            elapsedMs,
            ...(call.cached ? { cached: true } : {}),
          });
          warnings.push(`${providerId} returned no results`);
          continue;
        }
        attempts.push({
          provider: providerId,
          status: "ok",
          elapsedMs,
          ...(call.cached ? { cached: true } : {}),
        });
        warnings.push(...call.result.warnings);
        return {
          query: input.query,
          scope,
          mode: "fast",
          quality,
          backend: "external",
          provider: providerId,
          fallbackUsed: attempts.length > 1,
          attempts,
          sources: call.result.sources.slice(0, input.maxResults),
          ...(call.result.answer === undefined ? {} : { answer: call.result.answer }),
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

  private async webSearchRanked(
    input: SearchInput,
    quality: Quality,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const order = providerOrder(scope);
    const target = candidateTarget(
      quality,
      input.maxResults,
      this.config.rerankCandidateLimit,
    );
    const candidateInput: SearchInput = {
      ...input,
      quality,
      rerank: false,
      maxResults: providerRequestLimit(quality, input.maxResults),
    };
    const settled = await Promise.all(
      order.map(async (providerId) => {
        const started = performance.now();
        try {
          const call = await this.searchProvider(providerId, candidateInput, scope, signal);
          return {
            providerId,
            result: call.result,
            cached: call.cached,
            elapsedMs: Math.round(performance.now() - started),
          };
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
          ...(item.cached ? { cached: true } : {}),
        });
        warnings.push(`${item.providerId} returned no results`);
        continue;
      }
      successCount += 1;
      attempts.push({
        provider: item.providerId,
        status: "ok",
        elapsedMs: item.elapsedMs,
        ...(item.cached ? { cached: true } : {}),
      });
      candidates.push(...item.result.sources);
      warnings.push(...item.result.warnings);
      if (item.result.answer !== undefined && item.result.answer.length > 0) {
        answers.push(item.result.answer);
      }
    }

    const uniqueCandidates = dedupeSources(candidates).slice(0, target);
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
      quality,
      backend: "external" as const,
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
          strategy: "rank_fusion",
          weights: RANK_FUSION_WEIGHTS,
          inputCount: uniqueCandidates.length,
          candidateCount: uniqueCandidates.length,
          reason: "candidate_count_not_larger_than_result_limit",
        },
      };
    }

    try {
      const rerankCall = await this.rerankCandidates(input.query, uniqueCandidates, signal);
      const fused = fuseRankings(
        input.query,
        uniqueCandidates,
        rerankCall.result.sources,
      );
      return {
        ...base,
        sources: fused.sources
          .slice(0, input.maxResults)
          .map((source) => withoutRankingMetadata(source)),
        rerank: {
          requested: true,
          applied: true,
          provider: this.reranker.id,
          strategy: "rank_fusion",
          weights: RANK_FUSION_WEIGHTS,
          model: rerankCall.result.model,
          elapsedMs: rerankCall.result.elapsedMs,
          inputCount: rerankCall.result.inputCount,
          candidateCount: uniqueCandidates.length,
          ...(rerankCall.cached ? { cached: true } : {}),
          top1Protected: fused.top1Protected,
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
          strategy: "rank_fusion",
          weights: RANK_FUSION_WEIGHTS,
          inputCount: uniqueCandidates.length,
          candidateCount: uniqueCandidates.length,
          reason: rerankError.message,
        },
      };
    }
  }

  private async searchProvider(
    providerId: SearchProviderId,
    input: SearchInput,
    scope: "cn" | "global",
    signal?: AbortSignal,
  ): Promise<ProviderCall> {
    const key = hashCacheKey([
      "search",
      providerId,
      normalizeCacheQuery(input.query),
      scope,
      input.freshness,
      input.maxResults,
    ]);
    const cached = this.searchCache.get(key);
    if (cached !== undefined) {
      return {
        result: cloneProviderResult(cached),
        cached: true,
      };
    }

    const result = await this.providers[providerId].search(input, signal);
    if (result.sources.length > 0) {
      this.searchCache.set(key, cloneProviderResult(result));
    }
    return {
      result,
      cached: false,
    };
  }

  private async rerankCandidates(
    query: string,
    sources: SearchSource[],
    signal?: AbortSignal,
  ): Promise<RerankCall> {
    const key = hashCacheKey([
      "rerank",
      this.reranker.id,
      this.config.openRouterRerankModel,
      this.config.rerankInputChars,
      normalizeCacheQuery(query),
      sources.map((source) => ({
        url: canonicalizeUrl(source.url) ?? source.url,
        title: source.title ?? "",
        snippet: source.snippet ?? "",
      })),
    ]);
    const cached = this.rerankCache.get(key);
    if (cached !== undefined) {
      return {
        result: cloneRerankResult(cached),
        cached: true,
      };
    }

    const result = await this.reranker.rerank(query, sources, signal);
    this.rerankCache.set(key, cloneRerankResult(result));
    return {
      result,
      cached: false,
    };
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
          quality: "fast",
          rerank: false,
          backend: "external",
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
      quality: "fast",
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
