import { createHash } from "node:crypto";
import { hashCacheKey, TtlLruCache } from "../cache.js";
import type { AppConfig } from "../config.js";
import { ProviderError, errorText, type ProviderErrorCode } from "../errors.js";
import { OperationTimeoutError } from "../utils.js";
import type {
  OpenRouterCallOptions,
  OpenRouterCallResult,
  OpenRouterProviderId,
} from "./openrouter-client.js";
import { OpenRouterClient } from "./openrouter-client.js";

/** Smallest supported input batch for the embedding transport. */
export interface EmbeddingTransport {
  post<T>(
    provider: OpenRouterProviderId,
    path: string,
    body: unknown,
    options: OpenRouterCallOptions,
  ): Promise<OpenRouterCallResult<T>>;
}

export interface EmbeddingModelProfile {
  model: string;
  /**
   * Nominal vector width. `0` means "not known in advance; discover it from
   * the first successful response".
   */
  dims: number;
  /** Maximum number of input texts sent in one HTTP request. */
  maxBatch: number;
  /** Per-text character cap (the free models have small contexts). */
  maxChars: number;
  /** Maximum number of in-flight requests for this model. */
  concurrency: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Default cosine threshold for semantic syndication dedupe. */
  threshold: number;
  /** Whether the model has a built-in profile (false for user-supplied ids). */
  known: boolean;
}

/**
 * Result of one `embed` call.
 *
 * `vectors` is aligned 1:1 with the input `texts` array: `vectors[i]` is the
 * L2-normalized embedding of `texts[i]`. Whitespace-only inputs are never
 * sent and keep a zero-length slot. When a real text could not be embedded
 * (budget exhausted, request failure) its slot is a zero-length
 * `Float32Array` and `partial` is true - callers must check the length before
 * treating a vector as usable. Vector instances are read-only: the cache may
 * hand the same instance to several slots/callers.
 */
export interface Embedder {
  embed(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<{
    vectors: Float32Array[];
    model: string;
    dims: number;
    usage?: Record<string, unknown>;
    fallbackIndex?: number;
    partial: boolean;
  }>;
}

/** Optional accounting surface implemented by {@link OpenRouterEmbedder}. */
export interface EmbeddingStats {
  /** Non-empty input texts that were candidates for embedding. */
  candidates: number;
  /** Input texts whose vector was materialized by an API response (cache hits excluded). */
  embedded: number;
  /** Input texts served from the local vector cache. */
  cacheHits: number;
  /** HTTP requests issued by the embedding model that produced the result. */
  requests: number;
}

export interface CircuitAwareEmbedder extends Embedder {
  /** Whether the shared OpenRouter circuit breaker is currently open. */
  isCircuitOpen(): boolean;
}

interface ProfileDefinition {
  dims: number;
  maxBatch: number;
  maxChars: number;
  concurrency: number;
  timeoutMs: number;
  threshold: number;
}

/**
 * Free embedding models are the only tier this project is willing to spend
 * on. Each profile encodes the empirically observed limits: the 8b:free model
 * answers single inputs reliably but returns deterministic 502s for n>=3, so
 * it must be fanned out as parallel single-item requests.
 *
 * Thresholds are cosine cut-offs for semantic syndication dedupe. They come
 * from the 24-pair labelled capture in test/fixtures/semantic-capture.json
 * (real 4096-dim 8b vectors): duplicates score >= 0.8657 and distinct pairs
 * bottom out at 0.6115, so 0.62 separates them perfectly. 0.55 would merge
 * same-topic-different sources (FPR 0.294), which is why the 8b profile is
 * pinned at 0.62 rather than the earlier 0.55 guess.
 */
const PROFILE_DEFINITIONS: Readonly<Record<string, ProfileDefinition>> = {
  "nvidia/nemotron-3.5-embed-8b:free": {
    dims: 4096,
    maxBatch: 1,
    maxChars: 2400,
    concurrency: 8,
    timeoutMs: 8_000,
    threshold: 0.62,
  },
  "nvidia/llama-nemotron-embed-vl-1b-v2:free": {
    dims: 2048,
    maxBatch: 10,
    maxChars: 2400,
    concurrency: 1,
    timeoutMs: 5_000,
    threshold: 0.62,
  },
  "baai/bge-m3": {
    dims: 1024,
    maxBatch: 10,
    maxChars: 2400,
    concurrency: 1,
    timeoutMs: 8_000,
    threshold: 0.72,
  },
};

const UNKNOWN_PROFILE: ProfileDefinition = {
  dims: 0,
  maxBatch: 8,
  maxChars: 4_000,
  concurrency: 2,
  timeoutMs: 8_000,
  threshold: 0.65,
};

const EMBEDDINGS_PATH = "/api/v1/embeddings";

export function resolveProfile(model: string): EmbeddingModelProfile {
  const known = PROFILE_DEFINITIONS[model];
  if (known !== undefined) return { model, ...known, known: true };
  return { model, ...UNKNOWN_PROFILE, known: false };
}

/**
 * Per-model dedupe threshold, unless the operator pinned an explicit
 * `EMBEDDING_DEDUPE_THRESHOLD`. A single pin applies to whichever model is
 * used (including fallbacks), which keeps the merge decision predictable.
 */
export function resolveEmbeddingThreshold(
  config: Pick<AppConfig, "embeddingDedupeThreshold">,
  model: string,
): number {
  return config.embeddingDedupeThreshold ?? resolveProfile(model).threshold;
}

/** Deduplicated embedding model chain: primary first, then fallbacks. */
export function embeddingModelChain(
  config: Pick<AppConfig, "embeddingModel" | "embeddingFallbackModels">,
): string[] {
  const chain: string[] = [];
  for (const model of [config.embeddingModel, ...config.embeddingFallbackModels]) {
    const normalized = model.trim();
    if (normalized.length > 0 && !chain.includes(normalized)) chain.push(normalized);
  }
  return chain;
}

/**
 * Duck-typed circuit probe so semantic-dedupe can report breaker state without
 * depending on the concrete embedder implementation (test doubles stay simple).
 */
export function embedderCircuitOpen(embedder: Embedder): boolean {
  const candidate = embedder as Partial<CircuitAwareEmbedder>;
  if (typeof candidate.isCircuitOpen !== "function") return false;
  try {
    return candidate.isCircuitOpen() === true;
  } catch {
    return false;
  }
}

interface OpenRouterEmbeddingPayload {
  model?: string;
  data?: Array<{ index?: number; embedding?: unknown }>;
  usage?: Record<string, unknown>;
}

interface Chunk {
  text: string;
  indices: number[];
}

interface AttemptResult {
  model: string;
  dims: number;
  vectors: Array<Float32Array | undefined>;
  stats: EmbeddingStats;
  usage?: Record<string, unknown>;
  partial: boolean;
}

type AttemptOutcome =
  | { kind: "success"; result: AttemptResult }
  | { kind: "budget"; result: AttemptResult }
  | { kind: "failed"; error: unknown };

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function emptyStats(): EmbeddingStats {
  return { candidates: 0, embedded: 0, cacheHits: 0, requests: 0 };
}

function l2Normalize(values: number[]): Float32Array {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index]! / norm;
  }
  return vector;
}

function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

function mergeUsage(
  target: Record<string, unknown>,
  usage: Record<string, unknown> | undefined,
): void {
  if (usage === undefined) return;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const current = target[key];
      target[key] = typeof current === "number" ? current + value : value;
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

function invalidResponse(message: string): ProviderError {
  return new ProviderError("openrouter-embed", "invalid_response", message);
}

function parseEmbeddingResponse(
  payload: OpenRouterEmbeddingPayload,
  expectedCount: number,
  profile: EmbeddingModelProfile,
): { vectors: Float32Array[]; dims: number } {
  const items = Array.isArray(payload.data) ? payload.data : undefined;
  if (items === undefined) {
    throw invalidResponse("embedding response did not contain a data array");
  }
  if (items.length !== expectedCount) {
    throw invalidResponse(
      `embedding response returned ${items.length} vector(s) for ${expectedCount} input(s)`,
    );
  }
  const vectors = new Array<Float32Array>(expectedCount);
  const seen = new Set<number>();
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position]!;
    const index = typeof item.index === "number"
      && Number.isInteger(item.index)
      && item.index >= 0
      && item.index < expectedCount
      ? item.index
      : position;
    if (seen.has(index)) {
      throw invalidResponse(`embedding response returned duplicate index ${index}`);
    }
    seen.add(index);
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw invalidResponse(`embedding response item ${index} had no numeric vector`);
    }
    const values: number[] = [];
    for (const value of item.embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidResponse(`embedding response item ${index} contained a non-finite value`);
      }
      values.push(value);
    }
    const vector = l2Normalize(values);
    if (profile.dims > 0 && vector.length !== profile.dims) {
      throw invalidResponse(
        `${profile.model} returned ${vector.length}-dim vectors; the profile expects ${profile.dims}`,
      );
    }
    vectors[index] = vector;
  }
  const dims = vectors[0]!.length;
  for (const vector of vectors) {
    if (vector.length !== dims) {
      throw invalidResponse("embedding response mixed vector dimensions");
    }
  }
  return { vectors, dims };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const runners: Array<Promise<void>> = [];
  for (let slot = 0; slot < size; slot += 1) {
    runners.push((async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

/**
 * OpenRouter embedding client with per-model profiles, deterministic chunks,
 * model-level fallback, a global latency budget, vector caching and the shared
 * circuit breaker.
 *
 * Fallback is model-level, never chunk-level: vectors from different models do
 * not share a vector space, so a failed attempt with the primary model discards
 * whatever it produced and the whole operation is replayed on the next model.
 */
export class OpenRouterEmbedder implements Embedder {
  private readonly transport: EmbeddingTransport;
  private readonly cache: TtlLruCache<string, Float32Array>;
  private stats: EmbeddingStats = emptyStats();

  constructor(
    private readonly config: AppConfig,
    transport?: EmbeddingTransport,
  ) {
    this.transport = transport ?? new OpenRouterClient(config);
    this.cache = new TtlLruCache<string, Float32Array>({
      ttlMs: config.embeddingCacheTtlMs,
      maxEntries: config.embeddingCacheMaxEntries,
    });
  }

  /** Accounting for the most recent `embed` call (cache hits are separate). */
  getStats(): EmbeddingStats {
    return { ...this.stats };
  }

  clearCache(): void {
    this.cache.clear();
  }

  isCircuitOpen(): boolean {
    const candidate = this.transport as { isCircuitOpen?: unknown };
    if (typeof candidate.isCircuitOpen !== "function") return false;
    try {
      const probe = candidate.isCircuitOpen as (
        provider: OpenRouterProviderId,
        cooldownMs?: number,
      ) => boolean;
      return probe("openrouter-embed", this.config.embeddingCircuitCooldownMs) === true;
    } catch {
      return false;
    }
  }

  async embed(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<{
    vectors: Float32Array[];
    model: string;
    dims: number;
    usage?: Record<string, unknown>;
    fallbackIndex?: number;
    partial: boolean;
  }> {
    const startedAt = performance.now();
    const chain = embeddingModelChain(this.config);
    if (chain.length === 0) {
      throw new ProviderError(
        "openrouter-embed",
        "invalid_request",
        "no embedding model is configured",
      );
    }
    let final: AttemptResult | undefined;
    let usedIndex = 0;
    let lastError: unknown;
    for (let modelIndex = 0; modelIndex < chain.length; modelIndex += 1) {
      if (isAborted(signal)) throw this.abortError(signal!);
      const model = chain[modelIndex]!;
      const profile = resolveProfile(model);
      const truncated = texts.map((text) => truncateText(text, profile.maxChars));
      const outcome = await this.attempt(model, profile, truncated, startedAt, signal);
      if (isAborted(signal)) throw this.abortError(signal!);
      if (outcome.kind === "success" || outcome.kind === "budget") {
        final = outcome.result;
        usedIndex = modelIndex;
        break;
      }
      lastError = outcome.error;
    }
    if (final === undefined) throw this.aggregateFailure(chain, lastError);
    const usable = final.vectors.some((vector) => vector !== undefined);
    if (!usable && final.stats.candidates > 0) {
      throw final.partial
        ? new ProviderError(
          "openrouter-embed",
          "timeout",
          `embedding budget of ${this.config.embeddingBudgetMs}ms was exhausted before any vector was produced`,
          { retryable: true },
        )
        : this.aggregateFailure(chain, lastError);
    }
    this.stats = final.stats;
    const expected = final.stats.candidates;
    const satisfied = final.stats.embedded + final.stats.cacheHits;
    const partial = final.partial || (expected > 0 && satisfied < expected);
    const result: {
      vectors: Float32Array[];
      model: string;
      dims: number;
      usage?: Record<string, unknown>;
      fallbackIndex?: number;
      partial: boolean;
    } = {
      vectors: final.vectors.map((vector) => vector ?? new Float32Array(0)),
      model: final.model,
      dims: final.dims,
      partial,
    };
    if (final.usage !== undefined) result.usage = final.usage;
    if (usedIndex > 0) result.fallbackIndex = usedIndex;
    return result;
  }

  private abortError(signal: AbortSignal): ProviderError {
    const reason = signal.reason;
    return new ProviderError(
      "openrouter-embed",
      "timeout",
      `embedding aborted: ${reason instanceof Error ? errorText(reason) : "request cancelled"}`,
      { retryable: false, cause: reason },
    );
  }

  private aggregateFailure(chain: string[], lastError: unknown): ProviderError {
    const detail = lastError === undefined
      ? "no embedding request was attempted"
      : lastError instanceof Error
        ? errorText(lastError)
        : String(lastError);
    const code: ProviderErrorCode = lastError instanceof ProviderError
      ? lastError.code
      : "unknown";
    return new ProviderError(
      "openrouter-embed",
      code,
      `embedding failed for all models (${chain.join(", ")}): ${detail}`,
      { cause: lastError },
    );
  }

  private async attempt(
    model: string,
    profile: EmbeddingModelProfile,
    texts: string[],
    startedAt: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<AttemptOutcome> {
    const stats = emptyStats();
    const vectors = new Array<Float32Array | undefined>(texts.length).fill(undefined);
    const usage: Record<string, unknown> = {};
    const unique = new Map<string, Chunk>();
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index]!;
      if (text.length === 0) continue;
      stats.candidates += 1;
      const cacheKey = hashCacheKey(["embed", model, text]);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        vectors[index] = cached;
        stats.cacheHits += 1;
        continue;
      }
      const digest = createHash("sha256").update(text).digest("hex");
      const bucket = unique.get(digest);
      if (bucket === undefined) unique.set(digest, { text, indices: [index] });
      else bucket.indices.push(index);
    }
    const pending = [...unique.values()];
    const budgetMs = this.config.embeddingBudgetMs;
    const remaining = (): number => budgetMs - (performance.now() - startedAt);
    if (pending.length === 0) {
      return {
        kind: "success",
        result: { model, dims: profile.dims, vectors, stats, partial: false },
      };
    }
    if (remaining() <= 0) {
      return {
        kind: "budget",
        result: { model, dims: profile.dims, vectors, stats, partial: true },
      };
    }
    const chunks: Chunk[][] = [];
    for (let offset = 0; offset < pending.length; offset += profile.maxBatch) {
      chunks.push(pending.slice(offset, offset + profile.maxBatch));
    }
    const controller = new AbortController();
    let budgetExceeded = false;
    const timer = setTimeout(() => {
      budgetExceeded = true;
      controller.abort(new OperationTimeoutError(`embedding budget ${budgetMs}ms exceeded`));
    }, Math.max(1, Math.floor(remaining())));
    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted === true) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const outcomes = await runWithConcurrency(chunks, profile.concurrency, async (chunk) => {
        const timeLeft = remaining();
        if (controller.signal.aborted || timeLeft <= 0) {
          return {
            ok: false as const,
            error: new ProviderError(
              "openrouter-embed",
              "timeout",
              "embedding budget exhausted before the request was sent",
            ),
          };
        }
        const timeoutMs = Math.max(1, Math.min(profile.timeoutMs, Math.floor(timeLeft)));
        try {
          const response = await this.transport.post<OpenRouterEmbeddingPayload>(
            "openrouter-embed",
            EMBEDDINGS_PATH,
            { model, input: chunk.map((entry) => entry.text) },
            {
              timeoutMs,
              signal: controller.signal,
              circuitFailures: this.config.embeddingCircuitFailures,
              circuitCooldownMs: this.config.embeddingCircuitCooldownMs,
            },
          );
          stats.requests += 1;
          mergeUsage(usage, response.usage ?? response.data.usage);
          const parsed = parseEmbeddingResponse(response.data, chunk.length, profile);
          chunk.forEach((entry, position) => {
            const vector = parsed.vectors[position];
            if (vector !== undefined) {
              this.cache.set(hashCacheKey(["embed", model, entry.text]), vector);
            }
          });
          return { ok: true as const, chunk, vectors: parsed.vectors };
        } catch (error) {
          return { ok: false as const, error };
        }
      });
      const dimensions = new Set<number>();
      let embeddedTexts = 0;
      const failures: unknown[] = [];
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          failures.push(outcome.error);
          continue;
        }
        outcome.vectors.forEach((vector, position) => {
          const entry = outcome.chunk[position]!;
          dimensions.add(vector.length);
          for (const index of entry.indices) vectors[index] = vector;
          embeddedTexts += entry.indices.length;
        });
      }
      if (dimensions.size > 1) {
        return {
          kind: "failed",
          error: invalidResponse("embedding model returned mixed vector dimensions"),
        };
      }
      stats.embedded += embeddedTexts;
      const dims = dimensions.size === 1
        ? ([...dimensions][0] as number)
        : profile.dims;
      if (failures.length === 0) {
        const result: AttemptResult = { model, dims, vectors, stats, partial: false };
        if (Object.keys(usage).length > 0) result.usage = usage;
        return { kind: "success", result };
      }
      if (controller.signal.aborted || budgetExceeded) {
        const result: AttemptResult = {
          model,
          dims,
          vectors,
          stats,
          partial: true,
        };
        if (Object.keys(usage).length > 0) result.usage = usage;
        return { kind: "budget", result };
      }
      return { kind: "failed", error: failures[0] };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
