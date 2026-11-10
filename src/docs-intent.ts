import { hashCacheKey, normalizeCacheQuery, TtlLruCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { errorText } from "./errors.js";
import {
  OpenRouterDecisions,
  type DecisionsTransport,
} from "./providers/openrouter-decisions.js";
import type { DecisionsReport, Quality } from "./types.js";

/**
 * Version of the docs-intent question/probe. Bumping it invalidates every
 * cached probability, because the model output is only comparable for one
 * exact prompt.
 */
export const PROMPT_VERSION = "docs-intent-noul-v1";

/**
 * Dead-band boundaries. The decisions model is non-deterministic on the same
 * query (observed p spread 0.27-0.58), so a point threshold would flip results
 * between identical searches. Only confident answers are allowed to act:
 *
 * - p < 0.25      -> veto the regex (regex said docs, model strongly disagrees)
 * - p > 0.40      -> keep the regex
 * - 0.25 .. 0.40  -> dead band; fall back to the regex
 *
 * A veto is the only behavior that can change routing, so a wrong "keep" is
 * harmless and a dead band can never invent documentation intent.
 */
export const DECISIONS_VETO_BELOW = 0.25;
export const DECISIONS_KEEP_ABOVE = 0.4;

/** One cached classification. Only confident, validated calls are cached. */
export interface CachedDocsIntent {
  p: number;
  annotations?: number;
  model?: string;
}

/** Minimal cache shape so tests (and the service) can substitute a store. */
export interface DocsIntentCache {
  get(key: string): CachedDocsIntent | undefined;
  set(key: string, value: CachedDocsIntent): void;
}

export interface DocsIntentResolution extends DecisionsReport {}

/**
 * Opt-in docs-intent veto for the regex in `ranking.hasOfficialIntent`.
 *
 * The model is never a router and never a research sufficiency gate: it can
 * only veto a regex-positive documentation signal (or confirm it). With
 * `mode === "off"` or `shadow` the resolved intent is exactly the regex.
 * Every failure path returns the regex resolution instead of throwing, so the
 * search path never depends on network health for correctness.
 */
export class DocsIntentResolver {
  private readonly transport: DecisionsTransport;
  private readonly cache: DocsIntentCache;

  constructor(
    private readonly config: AppConfig,
    transport?: DecisionsTransport,
    cache?: DocsIntentCache,
  ) {
    this.transport = transport ?? new OpenRouterDecisions(config);
    this.cache = cache ?? new TtlLruCache<string, CachedDocsIntent>({
      ttlMs: config.openRouterDecisionsCacheTtlMs,
      maxEntries: config.openRouterDecisionsCacheMaxEntries,
    });
  }

  private skipped(fallbackReason: string, regexOfficialIntent: boolean): DocsIntentResolution {
    return {
      mode: this.config.decisionsMode,
      applied: false,
      verdict: "fallback",
      threshold: this.config.openRouterDecisionsThreshold,
      regexOfficialIntent,
      resolvedOfficialIntent: regexOfficialIntent,
      cached: false,
      fallbackReason,
      elapsedMs: 0,
    };
  }

  async resolve(
    query: string,
    requestedQuality: Quality,
    regexOfficialIntent: boolean,
    signal?: AbortSignal,
  ): Promise<DocsIntentResolution> {
    const mode = this.config.decisionsMode;
    // No configured model call is allowed to run when the feature is off.
    if (mode === "off") return this.skipped("mode_off", regexOfficialIntent);
    // Fast search is already the cheapest path; never spend latency on a veto.
    if (requestedQuality === "fast") {
      return this.skipped("requested_quality_fast", regexOfficialIntent);
    }
    // The model may only veto or confirm an existing docs signal, never create
    // one, so a regex miss short-circuits without a network call.
    if (!regexOfficialIntent) return this.skipped("regex_negative", regexOfficialIntent);

    const cacheKey = hashCacheKey([
      "docs-intent",
      this.config.openRouterDecisionsModel,
      PROMPT_VERSION,
      normalizeCacheQuery(query),
    ]);

    let p: number;
    let annotations: number | undefined;
    let cached = false;
    let elapsedMs = 0;
    try {
      const cachedEntry = this.cache.get(cacheKey);
      if (cachedEntry !== undefined) {
        p = cachedEntry.p;
        annotations = cachedEntry.annotations;
        cached = true;
      } else {
        const started = performance.now();
        const classification = await this.transport.classifyDocsIntent(query, {
          timeoutMs: this.config.openRouterDecisionsTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        });
        elapsedMs = classification.elapsedMs;
        if (
          typeof classification.p !== "number"
          || !Number.isFinite(classification.p)
          || classification.p < 0
          || classification.p > 1
        ) {
          return {
            ...this.skipped("invalid_response", regexOfficialIntent),
            elapsedMs: Math.round(performance.now() - started),
          };
        }
        p = classification.p;
        if (
          typeof classification.annotations === "number"
          && Number.isFinite(classification.annotations)
        ) {
          annotations = classification.annotations;
        }
        this.cache.set(cacheKey, {
          p,
          ...(annotations === undefined ? {} : { annotations }),
          ...(classification.model === undefined ? {} : { model: classification.model }),
        });
      }
    } catch (error) {
      // Timeout, breaker, missing credential, refusal, malformed body: all of
      // them degrade to the regex so a docs search still succeeds.
      return this.skipped(`transport_error: ${errorText(error)}`, regexOfficialIntent);
    }

    const verdict: DecisionsReport["verdict"] = p < DECISIONS_VETO_BELOW
      ? "veto"
      : p > DECISIONS_KEEP_ABOVE
        ? "keep"
        : "fallback";
    const shadow = mode === "shadow";
    const resolvedOfficialIntent = shadow || verdict === "fallback"
      ? regexOfficialIntent
      : verdict === "keep";
    return {
      mode,
      applied: !shadow && verdict !== "fallback",
      verdict,
      p,
      threshold: this.config.openRouterDecisionsThreshold,
      regexOfficialIntent,
      resolvedOfficialIntent,
      cached,
      ...(verdict === "fallback" ? { fallbackReason: "dead_band" } : {}),
      elapsedMs,
      ...(annotations === undefined ? {} : { annotations }),
    };
  }
}
