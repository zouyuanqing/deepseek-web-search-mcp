import { hashCacheKey, normalizeCacheQuery, TtlLruCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { ProviderError, errorText } from "./errors.js";
import {
  applyFreshnessPolicy,
  combineFreshnessReports,
  freshnessWarning,
} from "./freshness.js";
import { freshnessIntentWarning } from "./freshness-intent.js";
import {
  analyzeSourceIndependence,
  dedupeSourceIdentities,
} from "./source-identity.js";
import { DeepSeekNativeSearchProvider } from "./providers/deepseek-native.js";
import { DeepSeekSearchProvider } from "./providers/deepseek-search.js";
import { AnySearchProvider } from "./providers/anysearch.js";
import { OpenRouterReranker } from "./providers/openrouter-rerank.js";
import { TavilySearchProvider } from "./providers/tavily.js";
import { SearxngProvider } from "./providers/searxng.js";
import {
  candidateTarget,
  fuseRankings,
  hasOfficialIntent,
  authorityScore,
  providerRequestLimit,
  QUALITY_PROFILES,
  RANK_FUSION_WEIGHTS,
  resolveQuality,
  withoutRankingMetadata,
} from "./ranking.js";
import type {
  DeepSeekNativeProvider,
  EmbeddingReport,
  FreshnessReport,
  HealthReport,
  NativeSearchCall,
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
  SourceIdentityReport,
} from "./types.js";
import { cleanFastSources } from "./quality.js";
import { ResearchSessionStore } from "./research-session.js";
import { DocsIntentResolver } from "./docs-intent.js";
import { OpenRouterClient } from "./providers/openrouter-client.js";
import { OpenRouterDecisions } from "./providers/openrouter-decisions.js";
import { OpenRouterEmbedder, resolveEmbeddingThreshold } from "./providers/openrouter-embed.js";
import type { Embedder } from "./providers/openrouter-embed.js";
import { dedupeSourceIdentitiesSemantic } from "./semantic-dedupe.js";
import type { SemanticDedupeGroup } from "./semantic-dedupe.js";
import {
  applyFreshnessToQuery,
  canonicalizeUrl,
  dedupeSources,
  resolveScope,
} from "./utils.js";

export type ProviderRegistry = Record<SearchProviderId, SearchProvider>;
type CandidateProviderId = SearchProviderId | "deepseek-native";

interface ProviderCall {
  result: ProviderResult;
  cached: boolean;
  nativeSearch?: {
    requests: number;
    calls: NativeSearchCall[];
  };
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

export function hybridProviderOrder(scope: "cn" | "global"): CandidateProviderId[] {
  return [...providerOrder(scope), "deepseek-search"];
}

export function buildProviderRegistry(config: AppConfig): ProviderRegistry {
  return {
    anysearch: new AnySearchProvider(config),
    tavily: new TavilySearchProvider(config),
    searxng: new SearxngProvider(config),
    "deepseek-search": new DeepSeekSearchProvider(config),
  };
}

function cloneProviderResult(result: ProviderResult): ProviderResult {
  return {
    ...result,
    sources: result.sources.map((source) => ({ ...source })),
    warnings: [...result.warnings],
    ...(result.usage === undefined ? {} : { usage: { ...result.usage } }),
    ...(result.nativeSearch === undefined
      ? {}
      : {
        nativeSearch: {
          requests: result.nativeSearch.requests,
          calls: result.nativeSearch.calls.map((call) => ({ ...call })),
        },
      }),
  };
}

function cloneRerankResult(result: RerankResult): RerankResult {
  return {
    ...result,
    sources: result.sources.map((source) => ({ ...source })),
  };
}

function freshnessForProvider(
  provider: CandidateProviderId,
  input: SearchInput,
  sources: SearchSource[],
): ReturnType<typeof applyFreshnessPolicy> {
  return applyFreshnessPolicy(
    provider,
    sources,
    input.freshness,
    input.freshnessMode ?? "soft",
  );
}

function mergeProviderSources(groups: SearchSource[][], interleave: boolean): SearchSource[] {
  if (!interleave) return groups.flat();
  const output: SearchSource[] = [];
  const maxLength = groups.reduce((maximum, group) => Math.max(maximum, group.length), 0);
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const source = group[index];
      if (source !== undefined) output.push(source);
    }
  }
  return output;
}

function appendUniqueWarning(warnings: string[], message: string | undefined): void {
  if (message !== undefined && !warnings.includes(message)) warnings.push(message);
}

function sourceQuality(query: string, sources: SearchSource[]): NonNullable<ResearchResult["sourceQuality"]> {
  const independence = analyzeSourceIndependence(sources, {
    mergedCount: 0,
    crossHostCopyCount: 0,
  });
  return {
    officialSources: sources.filter((source) => authorityScore(query, source) >= 0.7).length,
    totalSources: sources.length,
    independentDomains: independence.independentDomains,
    independence: independence.independence,
  };
}

export class SearchService {
  private readonly nativeProvider: DeepSeekNativeProvider;
  private readonly reranker: Reranker;
  private readonly docsIntentResolver: DocsIntentResolver;
  private readonly embedder: Embedder;
  private readonly searchCache: TtlLruCache<string, ProviderResult>;
  private readonly rerankCache: TtlLruCache<string, RerankResult>;
  private readonly researchSessions: ResearchSessionStore;

  constructor(
    private readonly config: AppConfig,
    private readonly providers: ProviderRegistry = buildProviderRegistry(config),
    nativeProvider?: DeepSeekNativeProvider,
    reranker?: Reranker,
    deps: {
      docsIntent?: DocsIntentResolver;
      embedder?: Embedder;
      openRouterClient?: OpenRouterClient;
    } = {},
  ) {
    const client = deps.openRouterClient ?? new OpenRouterClient(config);
    this.nativeProvider = nativeProvider ?? new DeepSeekNativeSearchProvider(config);
    this.reranker = reranker ?? new OpenRouterReranker(config, client);
    this.docsIntentResolver = deps.docsIntent ?? new DocsIntentResolver(
      config,
      new OpenRouterDecisions(config, client),
    );
    this.embedder = deps.embedder ?? new OpenRouterEmbedder(config, client);
    this.searchCache = new TtlLruCache({
      ttlMs: config.searchCacheTtlMs,
      maxEntries: config.searchCacheMaxEntries,
    });
    this.rerankCache = new TtlLruCache({
      ttlMs: config.rerankCacheTtlMs,
      maxEntries: config.rerankCacheMaxEntries,
    });
    this.researchSessions = new ResearchSessionStore(
      config.researchSessionTtlMs,
      config.researchSessionMaxSessions,
    );
  }

  private cleanFastSources(
    input: SearchInput,
    sources: SearchSource[],
    officialIntent: boolean,
  ): {
    sources: SearchSource[];
    metadata: NonNullable<SearchResult["fastCleaning"]>;
  } {
    const cleaned = cleanFastSources(input.query, sources, {
      mode: this.config.fastCleaningMode,
      maxResults: input.maxResults,
      domainCap: this.config.fastDomainCap,
      officialIntent,
    });
    return {
      sources: cleaned.applied ? cleaned.sources : sources,
      metadata: {
        mode: this.config.fastCleaningMode,
        applied: cleaned.applied,
        candidateCount: cleaned.candidateCount,
        selectedCount: cleaned.applied
          ? cleaned.selectedCount
          : Math.min(sources.length, input.maxResults),
        providerCoverage: cleaned.providerCoverage,
      },
    };
  }

  /**
   * Language-variant and syndicated-copy collapse. Enabled by default because
   * the same article mirrored in /it/, /ar/ and /en/ is a correctness bug, not
   * a ranking preference, so it never competes with a legitimately distinct
   * source. SOURCE_IDENTITY_MODE=off restores the previous exact-URL dedupe.
   */
  private identifySources(
    sources: SearchSource[],
  ): { sources: SearchSource[]; report: SourceIdentityReport } {
    const identity = dedupeSourceIdentities(sources, {
      crossHost: this.config.sourceIdentityCrossHost,
    });
    const independence = analyzeSourceIndependence(identity.sources, identity);
    const report: SourceIdentityReport = {
      applied: this.config.sourceIdentityMode === "on",
      inputCount: sources.length,
      mergedCount: identity.mergedCount,
      languageVariantCount: identity.languageVariantCount,
      crossHostCopyCount: identity.crossHostCopyCount,
      conflictingDateCount: identity.conflictingDateCount,
      independence: {
        independentDomains: independence.independentDomains,
        dominantDomainShare: independence.dominantDomainShare,
        lowAuthorityShare: independence.lowAuthorityShare,
        level: independence.independence,
      },
      ...(this.config.sourceIdentityVerbose
        ? {
          groups: identity.groups.map((group) => ({
            keptUrl: group.keptUrl,
            mergedUrls: group.mergedUrls,
            hosts: group.hosts,
            reason: group.reason,
            dateConflict: group.dateConflict,
          })),
        }
        : {}),
    };
    return {
      sources: this.config.sourceIdentityMode === "off" ? dedupeSources(sources) : identity.sources,
      report,
    };
  }

  private identityWarnings(
    report: SourceIdentityReport,
    warnings: string[],
  ): string[] {
    const output = [...warnings];
    if (report.languageVariantCount > 0) {
      appendUniqueWarning(
        output,
        `Collapsed ${report.languageVariantCount} translated copy/copies of the same article into one source.`,
      );
    }
    if (report.crossHostCopyCount > 0) {
      appendUniqueWarning(
        output,
        `Collapsed ${report.crossHostCopyCount} syndicated copy/copies hosted on a different domain; agreement with the original is not independent corroboration.`,
      );
    }
    if (report.independence.level === "low") {
      appendUniqueWarning(
        output,
        `Only ${report.independence.independentDomains} independent domain(s) back this result set; treat numeric agreement as potentially copied.`,
      );
    }
    if (report.semanticCopyCount !== undefined && report.semanticCopyCount > 0) {
      appendUniqueWarning(
        output,
        `Collapsed ${report.semanticCopyCount} semantically equivalent syndicated copy/copies; semantic similarity is not independent corroboration.`,
      );
    }
    if (report.conflictingDateCount > 0) {
      appendUniqueWarning(
        output,
        `${report.conflictingDateCount} merged source group(s) had conflicting publishedAt values; the retained source's date was kept.`,
      );
    }
    return output;
  }

  async webSearch(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    const requestedQuality = resolveQuality(input);
    const regexOfficialIntent = hasOfficialIntent(input.query);
    // One resolution per request: the decisions model (when enabled) may only
    // veto the regex, never promote a non-docs query.
    const docsIntent = await this.docsIntentResolver.resolve(
      input.query,
      requestedQuality,
      regexOfficialIntent,
      signal,
    );
    const officialIntent = docsIntent.resolvedOfficialIntent;
    const quality = this.config.documentationQueryMode === "fast" && officialIntent
      ? "fast"
      : requestedQuality;
    const requestedBackend = input.backend ?? this.config.webSearchBackend ?? "auto";
    const backend = requestedBackend === "auto"
      ? this.config.deepseekApiKey === undefined ? "external" : "hybrid"
      : requestedBackend;
    let result: SearchResult;
    if (backend === "deepseek-native") {
      result = await this.webSearchNative(input, quality, signal);
    } else if (backend === "deepseek-search") {
      result = await this.webSearchOfficial(input, quality, officialIntent, signal);
    } else if (backend === "hybrid") {
      result = await this.webSearchHybrid(input, quality, officialIntent, signal);
    } else {
      result = await this.webSearchExternal(input, quality, officialIntent, signal);
    }
    if (docsIntent.mode !== "off") result.decisions = docsIntent;
    if (docsIntent.applied && docsIntent.verdict === "veto" && docsIntent.p !== undefined) {
      result.warnings = [...new Set([
        ...result.warnings,
        `Documentation routing suppressed: query is not documentation (p=${docsIntent.p.toFixed(3)}); rerank kept.`,
      ])];
    }
    if (quality !== requestedQuality) {
      result.warnings = [...new Set([
        ...result.warnings,
        `Documentation query routed from quality=${requestedQuality} to fast to protect primary documentation results.`,
      ])];
    }
    return result;
  }

  private async webSearchExternal(
    input: SearchInput,
    quality: Quality,
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    return this.webSearchProviderSet(
      input,
      quality,
      providerOrder(scope),
      "external",
      officialIntent,
      signal,
    );
  }

  /**
   * Official DeepSeek Search API only: a raw structured search with no model
   * turn. Balanced/deep still use the shared rank-fusion path so the result
   * shape stays identical to the other backends.
   */
  private async webSearchOfficial(
    input: SearchInput,
    quality: Quality,
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    return this.webSearchProviderSet(
      input,
      quality,
      ["deepseek-search"],
      "deepseek-search",
      officialIntent,
      signal,
    );
  }

  private async webSearchProviderSet(
    input: SearchInput,
    quality: Quality,
    order: SearchProviderId[],
    backend: "external" | "deepseek-search",
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    return QUALITY_PROFILES[quality].rerank
      ? this.webSearchRanked(input, quality, order, backend, officialIntent, signal)
      : this.webSearchFast(input, quality, order, backend, officialIntent, signal);
  }

  private async webSearchHybrid(
    input: SearchInput,
    quality: Quality,
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    return QUALITY_PROFILES[quality].rerank
      ? this.webSearchRanked(
        input,
        quality,
        hybridProviderOrder(scope),
        "hybrid",
        officialIntent,
        signal,
      )
      : this.webSearchAggregate(input, quality, officialIntent, signal);
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
      const freshness = freshnessForProvider("deepseek-native", input, native.sources);
      const elapsedMs = Math.round(performance.now() - started);
      const warnings = [...native.warnings];
      const freshnessMessage = freshnessWarning(freshness.report);
      appendUniqueWarning(warnings, freshnessMessage);
      if (freshness.sources.length === 0 && input.freshnessMode === "strict") {
        throw new ProviderError(
          "deepseek-native",
          "no_results",
          "Freshness constraint removed all native sources.",
        );
      }
      if (input.rerank === true || quality !== "fast") {
        warnings.push("The deepseek-native backend does not use external-provider rank fusion.");
      }
      const identified = this.identifySources(freshness.sources);
      const mergedWarnings = this.identityWarnings(identified.report!, warnings);
      appendUniqueWarning(
        mergedWarnings,
        this.config.freshnessIntentWarning
          ? freshnessIntentWarning(input.query, input.freshness, input.freshnessMode)
          : undefined,
      );
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
        sources: identified.sources.slice(0, input.maxResults),
        answer: native.answerMarkdown,
        warnings: mergedWarnings,
        nativeSearchRequests: native.nativeSearchRequests,
        nativeSearchCalls: native.nativeSearchCalls,
        nativeSearchDegraded: false,
        freshness: combineFreshnessReports(
          [freshness.report],
          input.freshness,
          input.freshnessMode ?? "soft",
          input.query,
        ),
        sourceIdentity: identified.report,
      };
    } catch (error) {
      throw error instanceof ProviderError
        ? error
        : new ProviderError("deepseek-native", "unknown", errorText(error), { cause: error });
    }
  }

  private async webSearchFast(
    input: SearchInput,
    quality: Quality,
    order: SearchProviderId[],
    backend: "external" | "deepseek-search",
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const attempts: ProviderAttempt[] = [];
    const warnings: string[] = [];
    const freshnessReports: FreshnessReport[] = [];
    let lastError: unknown;
    const providerInput: SearchInput = {
      ...input,
      quality,
      rerank: false,
      maxResults: providerRequestLimit(quality, input.maxResults),
    };

    for (const providerId of order) {
      const started = performance.now();
      try {
        const call = await this.searchProvider(providerId, providerInput, scope, signal);
        const elapsedMs = Math.round(performance.now() - started);
        const freshness = freshnessForProvider(providerId, input, call.result.sources);
        const freshnessMessage = freshnessWarning(freshness.report, providerId);
        appendUniqueWarning(warnings, freshnessMessage);
        if (freshness.sources.length === 0) {
          attempts.push({
            provider: providerId,
            status: "empty",
            elapsedMs,
            ...(call.cached ? { cached: true } : {}),
          });
          warnings.push(`${providerId} returned no results`);
          continue;
        }
        // Only providers that actually contributed to the returned set may
        // describe the overall freshness status. Aggregating a provider whose
        // results were all filtered out reports "unmet" for sources that did
        // satisfy the constraint.
        freshnessReports.push(freshness.report);
        attempts.push({
          provider: providerId,
          status: "ok",
          elapsedMs,
          ...(call.cached ? { cached: true } : {}),
        });
        warnings.push(...call.result.warnings);
        const cleaned = this.cleanFastSources(input, freshness.sources, officialIntent);
        const identified = this.identifySources(cleaned.sources);
        const mergedWarnings = this.identityWarnings(identified.report!, warnings);
        appendUniqueWarning(
          mergedWarnings,
          this.config.freshnessIntentWarning
            ? freshnessIntentWarning(input.query, input.freshness, input.freshnessMode)
            : undefined,
        );
        return {
          query: input.query,
          scope,
          mode: "fast",
          quality,
          backend,
          provider: providerId,
          fallbackUsed: attempts.length > 1,
          attempts,
          sources: identified.sources.slice(0, input.maxResults),
          ...(call.result.answer === undefined ? {} : { answer: call.result.answer }),
          warnings: mergedWarnings,
          freshness: combineFreshnessReports(
            freshnessReports,
            input.freshness,
            input.freshnessMode ?? "soft",
            input.query,
          ),
          fastCleaning: cleaned.metadata,
          sourceIdentity: identified.report,
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

    // A single-provider backend must keep the provider's error so callers see
    // the real cause (auth_error, rate_limited, ...) instead of a generic
    // "all providers failed" message. Multi-provider backends aggregate.
    if (order.length === 1 && lastError instanceof ProviderError) throw lastError;
    const allEmpty = attempts.length > 0
      && attempts.every((attempt) => attempt.status === "empty");
    throw new ProviderError(
      "service",
      "no_results",
      allEmpty
        ? `No search results for query "${input.query}"`
        : `All search providers failed for query "${input.query}"`,
      { cause: lastError },
    );
  }

  private async webSearchAggregate(
    input: SearchInput,
    quality: Quality,
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const order = hybridProviderOrder(scope);
    const providerInput: SearchInput = {
      ...input,
      quality,
      rerank: false,
      maxResults: providerRequestLimit(quality, input.maxResults),
    };
    const settled = await Promise.all(
      order.map(async (providerId) => {
        const started = performance.now();
        try {
          const call = await this.searchCandidateProvider(providerId, providerInput, scope, signal);
          const freshness = freshnessForProvider(providerId, providerInput, call.result.sources);
          return {
            providerId,
            result: { ...call.result, sources: freshness.sources },
            cached: call.cached,
            freshnessReport: freshness.report,
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
    const freshnessReports: FreshnessReport[] = [];
    const sourceGroups: SearchSource[][] = [];
    const answers: string[] = [];
    const successfulProviders: CandidateProviderId[] = [];
    let lastError: unknown;

    for (const item of settled) {
      if ("error" in item) {
        lastError = item.error;
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
      const freshnessMessage = freshnessWarning(item.freshnessReport, item.providerId);
      appendUniqueWarning(warnings, freshnessMessage);
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
      freshnessReports.push(item.freshnessReport);
      successfulProviders.push(item.providerId);
      attempts.push({
        provider: item.providerId,
        status: "ok",
        elapsedMs: item.elapsedMs,
        ...(item.cached ? { cached: true } : {}),
      });
      sourceGroups.push(item.result.sources);
      warnings.push(...item.result.warnings);
      if (item.result.answer !== undefined && item.result.answer.length > 0) {
        answers.push(item.result.answer);
      }
    }

    const cleaned = this.cleanFastSources(
      input,
      dedupeSources(mergeProviderSources(sourceGroups, true)),
      officialIntent,
    );
    const identified = this.identifySources(cleaned.sources);
    const sources = identified.sources.slice(0, input.maxResults);
    if (sources.length === 0) {
      const allEmpty = attempts.length > 0
        && attempts.every((attempt) => attempt.status === "empty");
      throw new ProviderError(
        "service",
        "no_results",
        allEmpty
          ? `No search results for query "${input.query}"`
          : `All search providers failed for query "${input.query}"`,
        { cause: lastError },
      );
    }
    const mergedWarnings = this.identityWarnings(identified.report!, warnings);
    appendUniqueWarning(
      mergedWarnings,
      this.config.freshnessIntentWarning
        ? freshnessIntentWarning(input.query, input.freshness, input.freshnessMode)
        : undefined,
    );

    return {
      query: input.query,
      scope,
      mode: "fast",
      quality,
      backend: "hybrid",
      provider: successfulProviders.length > 1
        ? "multiple"
        : successfulProviders[0] ?? null,
      fallbackUsed: successfulProviders.length < order.length,
      attempts,
      sources,
      ...(answers[0] === undefined ? {} : { answer: answers[0] }),
      warnings: mergedWarnings,
      freshness: combineFreshnessReports(
        freshnessReports,
        input.freshness,
        input.freshnessMode ?? "soft",
        input.query,
      ),
      fastCleaning: cleaned.metadata,
      sourceIdentity: identified.report,
    };
  }

  private async webSearchRanked(
    input: SearchInput,
    quality: Quality,
    order: CandidateProviderId[],
    backend: SearchResult["backend"],
    officialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = resolveScope(input.query, input.scope);
    const hybrid = backend === "hybrid";
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
          const call = await this.searchCandidateProvider(providerId, candidateInput, scope, signal);
          const freshness = freshnessForProvider(providerId, candidateInput, call.result.sources);
          return {
            providerId,
            result: { ...call.result, sources: freshness.sources },
            cached: call.cached,
            freshnessReport: freshness.report,
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
    const freshnessReports: FreshnessReport[] = [];
    const sourceGroups: SearchSource[][] = [];
    const answers: string[] = [];
    let successCount = 0;
    let lastError: unknown;

    for (const item of settled) {
      if ("error" in item) {
        lastError = item.error;
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
      const freshnessMessage = freshnessWarning(item.freshnessReport, item.providerId);
      appendUniqueWarning(warnings, freshnessMessage);
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
      freshnessReports.push(item.freshnessReport);
      successCount += 1;
      attempts.push({
        provider: item.providerId,
        status: "ok",
        elapsedMs: item.elapsedMs,
        ...(item.cached ? { cached: true } : {}),
      });
      sourceGroups.push(item.result.sources);
      warnings.push(...item.result.warnings);
      if (item.result.answer !== undefined && item.result.answer.length > 0) {
        answers.push(item.result.answer);
      }
    }

    const identifiedCandidates = this.identifySources(
      dedupeSources(mergeProviderSources(sourceGroups, hybrid)),
    );
    const semantic = await this.applySemanticDedupe(identifiedCandidates.sources, signal);
    const semanticApplied = semantic.semanticCopyCount > 0;
    const postIdentity = semanticApplied
      ? dedupeSourceIdentities(semantic.sources, {
        crossHost: this.config.sourceIdentityCrossHost,
      })
      : undefined;
    const postIndependence = postIdentity === undefined
      ? identifiedCandidates.report.independence
      : (() => {
        const analysis = analyzeSourceIndependence(postIdentity.sources, postIdentity);
        return {
          independentDomains: analysis.independentDomains,
          dominantDomainShare: analysis.dominantDomainShare,
          lowAuthorityShare: analysis.lowAuthorityShare,
          level: analysis.independence,
        };
      })();
    const verboseGroups = this.config.sourceIdentityVerbose
      ? [
        ...(identifiedCandidates.report.groups ?? []),
        ...semantic.groups.map((group) => ({ ...group })),
      ]
      : undefined;
    const sourceIdentityReport: SourceIdentityReport = {
      ...identifiedCandidates.report,
      mergedCount: identifiedCandidates.report.mergedCount + semantic.semanticCopyCount,
      conflictingDateCount:
        identifiedCandidates.report.conflictingDateCount + semantic.dateConflicts,
      independence: postIndependence,
      ...(semanticApplied ? { semanticCopyCount: semantic.semanticCopyCount } : {}),
      ...(verboseGroups === undefined ? {} : { groups: verboseGroups }),
    };
    const uniqueCandidates = semantic.sources.slice(0, target);
    if (uniqueCandidates.length === 0) {
      if (order.length === 1 && lastError instanceof ProviderError) throw lastError;
      const allEmpty = attempts.length > 0
        && attempts.every((attempt) => attempt.status === "empty");
      throw new ProviderError(
        "service",
        "no_results",
        allEmpty
          ? `No search results for query "${input.query}"`
          : `All search providers failed for query "${input.query}"`,
        { cause: lastError },
      );
    }

    const mergedWarnings = this.identityWarnings(sourceIdentityReport, warnings);
    appendUniqueWarning(
      mergedWarnings,
      this.config.freshnessIntentWarning
        ? freshnessIntentWarning(input.query, input.freshness, input.freshnessMode)
        : undefined,
    );

    const base = {
      query: input.query,
      scope,
      mode: "reranked" as const,
      quality,
      backend,
      provider: successCount > 1 ? ("multiple" as const) : settled.find(
        (item) => "result" in item && item.result.sources.length > 0,
      )?.providerId ?? null,
      fallbackUsed: successCount < order.length,
      attempts,
      ...(answers[0] === undefined ? {} : { answer: answers[0] }),
      warnings: mergedWarnings,
      freshness: combineFreshnessReports(
        freshnessReports,
        input.freshness,
        input.freshnessMode ?? "soft",
        input.query,
      ),
      sourceIdentity: sourceIdentityReport,
      ...(semantic.report === undefined ? {} : { embedding: semantic.report }),
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
      const rerankModel = this.resolveRerankModel(quality);
      const rerankCall = await this.rerankCandidates(
        input.query,
        uniqueCandidates,
        rerankModel,
        signal,
      );
      const rerankModelUsed = rerankCall.result.model ?? rerankModel;
      const fused = fuseRankings(
        input.query,
        uniqueCandidates,
        rerankCall.result.sources,
        {
          officialIntent,
          rerankModel: rerankModelUsed,
          rerankNormalization: this.config.rerankNormalization,
          confidenceFloor: this.config.rerankConfidenceFloor,
          top1Min: this.config.rerankTop1Min,
        },
      );
      const calibration = fused.calibration;
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
          model: rerankModelUsed,
          elapsedMs: rerankCall.result.elapsedMs,
          inputCount: rerankCall.result.inputCount,
          candidateCount: uniqueCandidates.length,
          ...(rerankCall.cached ? { cached: true } : {}),
          top1Protected: fused.top1Protected,
          ...(calibration === undefined
            ? {}
            : {
              normalization: calibration.mode,
              ...(calibration.rawMin === undefined || calibration.rawMax === undefined
                ? {}
                : {
                  scoreRange: {
                    min: calibration.rawMin,
                    max: calibration.rawMax,
                    spread: calibration.spread ?? calibration.rawMax - calibration.rawMin,
                  },
                }),
              signalQuality: calibration.signalQuality,
            }),
          ...(rerankCall.result.usage === undefined ? {} : { usage: rerankCall.result.usage }),
        },
      };
    } catch (error) {
      const rerankError = error instanceof ProviderError
        ? error
        : new ProviderError(this.reranker.id, "unknown", errorText(error), { cause: error });
      mergedWarnings.push(`Rerank failed; returned provider order: ${rerankError.message}`);
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

  private async searchNativeProvider(
    input: SearchInput,
    scope: "cn" | "global",
    signal?: AbortSignal,
  ): Promise<ProviderCall> {
    const key = hashCacheKey([
      "search",
      "deepseek-native",
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
        ...(cached.nativeSearch === undefined
          ? {}
          : { nativeSearch: cached.nativeSearch }),
      };
    }

    const native = await this.nativeProvider.research(
      {
        query: applyFreshnessToQuery(input.query, input.freshness),
        maxSources: input.maxResults,
        freshness: input.freshness,
      },
      signal,
    );
    const result: ProviderResult = {
      provider: "deepseek-native",
      sources: native.sources,
      answer: native.answerMarkdown,
      warnings: native.warnings,
      ...(native.usage === undefined ? {} : { usage: native.usage }),
      nativeSearch: {
        requests: native.nativeSearchRequests,
        calls: native.nativeSearchCalls,
      },
    };
    if (result.sources.length > 0) {
      this.searchCache.set(key, cloneProviderResult(result));
    }
    return {
      result,
      cached: false,
      nativeSearch: {
        requests: native.nativeSearchRequests,
        calls: native.nativeSearchCalls,
      },
    };
  }

  private async searchCandidateProvider(
    providerId: CandidateProviderId,
    input: SearchInput,
    scope: "cn" | "global",
    signal?: AbortSignal,
  ): Promise<ProviderCall> {
    return providerId === "deepseek-native"
      ? this.searchNativeProvider(input, scope, signal)
      : this.searchProvider(providerId, input, scope, signal);
  }

  private async rerankCandidates(
    query: string,
    sources: SearchSource[],
    model: string,
    signal?: AbortSignal,
  ): Promise<RerankCall> {
    const key = hashCacheKey([
      "rerank",
      this.reranker.id,
      model,
      this.config.rerankInputChars,
      normalizeCacheQuery(query),
      sources.map((source) => ({
        url: canonicalizeUrl(source.url) ?? source.url,
        provider: source.provider,
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

    const result = await this.reranker.rerank(query, sources, signal, { model });
    this.rerankCache.set(key, cloneRerankResult(result));
    return {
      result,
      cached: false,
    };
  }

  private resolveRerankModel(quality: Quality): string {
    if (quality === "balanced") {
      return this.config.openRouterRerankModelBalanced ?? this.config.openRouterRerankModel;
    }
    if (quality === "deep") {
      return this.config.openRouterRerankModelDeep ?? this.config.openRouterRerankModel;
    }
    return this.config.openRouterRerankModel;
  }

  /**
   * Optional semantic syndication dedupe. Only balanced/deep reach this path;
   * off mode, missing credentials and any embedder failure degrade to the
   * lexical source identity result, so the search itself never depends on the
   * flaky free embedding endpoint.
   */
  private async applySemanticDedupe(
    sources: SearchSource[],
    signal?: AbortSignal,
  ): Promise<{
    sources: SearchSource[];
    report?: EmbeddingReport;
    semanticCopyCount: number;
    groups: SemanticDedupeGroup[];
    dateConflicts: number;
  }> {
    if (
      this.config.embeddingMode === "off"
      || this.config.openRouterApiKey === undefined
    ) {
      return { sources, semanticCopyCount: 0, groups: [], dateConflicts: 0 };
    }
    try {
      const result = await dedupeSourceIdentitiesSemantic(sources, {
        crossHost: this.config.sourceIdentityCrossHost,
        mode: this.config.embeddingMode,
        threshold: resolveEmbeddingThreshold(this.config, this.config.embeddingModel),
        thresholdForModel: (model) => resolveEmbeddingThreshold(this.config, model),
        maxPairs: this.config.embeddingMaxPairs,
        embedder: this.embedder,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        sources: result.sources,
        report: result.report,
        semanticCopyCount: result.semanticCopyCount,
        groups: result.groups,
        dateConflicts: result.groups.filter((group) => group.dateConflict).length,
      };
    } catch {
      return { sources, semanticCopyCount: 0, groups: [], dateConflicts: 0 };
    }
  }

  async webResearch(input: ResearchInput, signal?: AbortSignal): Promise<ResearchResult> {
    try {
      const native = await this.nativeProvider.research(input, signal);
      const freshness = applyFreshnessPolicy(
        "deepseek-native",
        native.sources,
        input.freshness,
        input.freshnessMode ?? "soft",
      );
      if (freshness.sources.length === 0 && input.freshnessMode === "strict") {
        throw new ProviderError(
          "deepseek-native",
          "no_results",
          "Freshness constraint removed all native sources.",
        );
      }
      const freshnessMessage = freshnessWarning(freshness.report);
      const identified = this.identifySources(freshness.sources);
      const independence = analyzeSourceIndependence(identified.sources, {
        mergedCount: identified.report?.mergedCount ?? 0,
        crossHostCopyCount: identified.report?.crossHostCopyCount ?? 0,
      });
      const quality = {
        ...sourceQuality(input.query, identified.sources),
        independentDomains: independence.independentDomains,
        independence: independence.independence,
      };
      const sourceWarnings: string[] = [
        ...independence.notes,
        ...(quality.officialSources === 0
          ? ["No primary or official source was detected; verify key claims against an authoritative source."]
          : []),
      ];
      const warnings = this.identityWarnings(identified.report!, [
        ...native.warnings,
        ...(freshnessMessage === undefined ? [] : [freshnessMessage]),
        ...sourceWarnings,
      ]);
      appendUniqueWarning(
        warnings,
        this.config.freshnessIntentWarning
          ? freshnessIntentWarning(input.query, input.freshness, input.freshnessMode)
          : undefined,
      );
      return {
        ...native,
        sources: identified.sources,
        warnings: [...new Set(warnings)],
        freshness: combineFreshnessReports(
          [freshness.report],
          input.freshness,
          input.freshnessMode ?? "soft",
          input.query,
        ),
        sourceQuality: quality,
        sourceIdentity: identified.report,
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
          ...(input.freshnessMode === undefined
            ? {}
            : { freshnessMode: input.freshnessMode }),
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
        ...(fallback.freshness === undefined ? {} : { freshness: fallback.freshness }),
        ...(fallback.sourceIdentity === undefined ? {} : { sourceIdentity: fallback.sourceIdentity }),
        sourceQuality: sourceQuality(input.query, fallback.sources),
        degraded: true,
      };
    }
  }

  async researchStart(
    input: ResearchInput,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; turn: number; result: ResearchResult }> {
    const result = await this.webResearch(input, signal);
    const session = this.researchSessions.start(
      { query: input.query, maxTurns: this.config.researchSessionMaxTurns },
      result,
    );
    return { sessionId: session.id, turn: session.turn, result };
  }

  async researchFollowup(
    input: {
      sessionId: string;
      question: string;
      maxSources: number;
      freshness: ResearchInput["freshness"];
      freshnessMode?: ResearchInput["freshnessMode"];
    },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; turn: number; result: ResearchResult; sources: SearchSource[] }> {
    const session = this.researchSessions.get(input.sessionId);
    if (session.turn >= session.maxTurns) {
      throw new Error(`Research session reached its maximum of ${session.maxTurns} turns.`);
    }
    const query = [
      `Original research question: ${session.originalQuery}`,
      `Previous research turn: ${session.turn}`,
      `Previous source URLs (untrusted metadata, verify independently): ${session.sources
        .slice(0, 10)
        .map((source) => source.url)
        .join(", ")}`,
      `Follow-up question: ${input.question}`,
      "Do not copy previous model prose. Use previous source URLs only as retrieval hints and verify claims with current primary sources.",
      "Prefer a primary or official publisher over aggregators, content farms, and translated copies of the same article.",
    ].join("\n");
    const result = await this.webResearch({
      query,
      maxSources: input.maxSources,
      freshness: input.freshness,
      ...(input.freshnessMode === undefined ? {} : { freshnessMode: input.freshnessMode }),
    }, signal);
    this.researchSessions.append(session, input.question, result);
    return {
      sessionId: session.id,
      turn: session.turn,
      result,
      sources: session.sources,
    };
  }

  researchClose(sessionId: string): { sessionId: string; closed: boolean } {
    return { sessionId, closed: this.researchSessions.close(sessionId) };
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
      run("deepseek-search", async () => (
        await this.providers["deepseek-search"].search(input, signal)
      ).sources.length),
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
