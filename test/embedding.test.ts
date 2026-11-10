import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import type { OpenRouterCallOptions } from "../src/providers/openrouter-client.js";
import {
  OpenRouterEmbedder,
  embedderCircuitOpen,
  embeddingModelChain,
  resolveEmbeddingThreshold,
  resolveProfile,
  type Embedder,
  type EmbeddingTransport,
} from "../src/providers/openrouter-embed.js";

const PRIMARY = "nvidia/nemotron-3.5-embed-8b:free";
const LLAMA = "nvidia/llama-nemotron-embed-vl-1b-v2:free";
const BGE = "baai/bge-m3";

function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ OPENROUTER_API_KEY: "test-key", ...env });
}

interface FakeContext {
  model: string;
  input: string[];
  call: number;
}

interface FakeTransportOptions {
  vector?: (context: FakeContext) => number[][] | Promise<number[][]>;
  fail?: (context: FakeContext) => Error | undefined;
  delayMs?: (context: FakeContext) => number;
}

interface RecordedRequest {
  model: string;
  input: string[];
  timeoutMs: number;
}

type FakeTransport = EmbeddingTransport & {
  requests: RecordedRequest[];
  maxInFlight: number;
  failModels: Set<string>;
  isCircuitOpen?: () => boolean;
};

function profileDims(model: string): number {
  const dims = resolveProfile(model).dims;
  return dims > 0 ? dims : 3;
}

function defaultVectors(model: string, input: string[]): number[][] {
  const dims = profileDims(model);
  return input.map((_text, inputIndex) => Array.from(
    { length: dims },
    (_value, component) => (component === 0 ? 1 : inputIndex === 1 && component === 1 ? 0 : 0),
  ));
}

function fakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const requests: RecordedRequest[] = [];
  let call = 0;
  let inFlight = 0;
  const transport: FakeTransport = {
    requests,
    maxInFlight: 0,
    failModels: new Set<string>(),
    async post<T>(
      _provider: "openrouter-embed",
      _path: string,
      body: unknown,
      callOptions: OpenRouterCallOptions,
    ) {
      const payload = body as { model: string; input: string[] };
      const context: FakeContext = { model: payload.model, input: payload.input, call };
      call += 1;
      requests.push({ model: payload.model, input: [...payload.input], timeoutMs: callOptions.timeoutMs });
      inFlight += 1;
      transport.maxInFlight = Math.max(transport.maxInFlight, inFlight);
      try {
        const failure = transport.failModels.has(payload.model)
          ? new ProviderError("openrouter-embed", "network_error", `${payload.model} is down`)
          : options.fail?.(context);
        if (failure !== undefined) throw failure;
        const delay = options.delayMs?.(context) ?? 0;
        // Always yield a macrotask: a real HTTP call is asynchronous, so
        // concurrent requests must be observable while they are in flight.
        await new Promise<void>((resolve, reject) => {
          const signal = callOptions.signal;
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, delay);
          const onAbort = (): void => {
            cleanup();
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          const cleanup = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          };
          if (signal?.aborted === true) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        const vectors = options.vector !== undefined
          ? await options.vector(context)
          : defaultVectors(payload.model, payload.input);
        const data = {
          model: payload.model,
          data: vectors.map((embedding, index) => ({ index, embedding })),
          usage: { prompt_tokens: payload.input.length, total_tokens: payload.input.length },
        };
        return { data: data as T, status: 200, elapsedMs: 1 };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return transport;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function vectorValues(vector: Float32Array): number[] {
  return [...vector];
}

describe("embedding model profiles", () => {
  it("encodes the empirical limits of the 8b:free primary model", () => {
    const profile = resolveProfile(PRIMARY);
    expect(profile).toMatchObject({
      model: PRIMARY,
      dims: 4096,
      maxBatch: 1,
      maxChars: 2400,
      concurrency: 8,
      timeoutMs: 8000,
      threshold: 0.62,
      known: true,
    });
  });

  it("encodes the llama 1b fallback profile", () => {
    expect(resolveProfile(LLAMA)).toMatchObject({
      dims: 2048,
      maxBatch: 10,
      maxChars: 2400,
      concurrency: 1,
      timeoutMs: 5000,
      threshold: 0.62,
      known: true,
    });
  });

  it("encodes the bge-m3 fallback profile", () => {
    expect(resolveProfile(BGE)).toMatchObject({
      dims: 1024,
      maxBatch: 10,
      maxChars: 2400,
      concurrency: 1,
      timeoutMs: 8000,
      threshold: 0.72,
      known: true,
    });
  });

  it("falls back to discoverable defaults for unknown models", () => {
    const profile = resolveProfile("custom/embedding-model");
    expect(profile.known).toBe(false);
    expect(profile.dims).toBe(0);
    expect(profile.maxBatch).toBeGreaterThan(0);
    expect(profile.timeoutMs).toBeGreaterThan(0);
    expect(profile.threshold).toBeGreaterThan(0);
  });

  it("resolves the dedupe threshold from the model profile", () => {
    expect(resolveEmbeddingThreshold({}, PRIMARY)).toBe(0.62);
    expect(resolveEmbeddingThreshold({}, LLAMA)).toBe(0.62);
    expect(resolveEmbeddingThreshold({}, BGE)).toBe(0.72);
    expect(resolveEmbeddingThreshold({}, "custom/embedding-model")).toBe(0.65);
  });

  it("lets the operator override every model threshold", () => {
    expect(resolveEmbeddingThreshold({ embeddingDedupeThreshold: 0.7 }, PRIMARY)).toBe(0.7);
    expect(resolveEmbeddingThreshold(loadConfig({ EMBEDDING_DEDUPE_THRESHOLD: "0.68" }), PRIMARY)).toBe(0.68);
  });

  it("builds a deduplicated primary-then-fallback chain", () => {
    expect(embeddingModelChain(config())).toEqual([PRIMARY, LLAMA, BGE]);
    expect(embeddingModelChain(config({
      EMBEDDING_MODEL: BGE,
      EMBEDDING_FALLBACK_MODELS: `${BGE},${LLAMA}`,
    }))).toEqual([BGE, LLAMA]);
    expect(embeddingModelChain({ embeddingModel: PRIMARY, embeddingFallbackModels: [] })).toEqual([PRIMARY]);
  });

  it("ships with embeddings off by default", () => {
    const defaults = loadConfig({});
    expect(defaults.embeddingMode).toBe("off");
    expect(defaults.embeddingModel).toBe(PRIMARY);
    expect(defaults.embeddingFallbackModels).toEqual([LLAMA, BGE]);
    expect(defaults.embeddingMaxPairs).toBe(8);
    expect(defaults.embeddingBudgetMs).toBe(6000);
    expect(defaults.embeddingCircuitFailures).toBe(5);
    expect(defaults.embeddingCircuitCooldownMs).toBe(120000);
  });
});

describe("batching and normalization", () => {
  it("fans a maxBatch-1 model out into parallel single-item requests", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config(), transport);
    const result = await embedder.embed(["first text", "second text", "third text"]);

    expect(transport.requests.map((request) => request.input)).toEqual([
      ["first text"],
      ["second text"],
      ["third text"],
    ]);
    expect(transport.maxInFlight).toBe(3);
    expect(result.model).toBe(PRIMARY);
    expect(result.dims).toBe(4096);
    expect(result.vectors).toHaveLength(3);
    for (const vector of result.vectors) expect(vector).toHaveLength(4096);
    expect(result.partial).toBe(false);
    expect(embedder.getStats()).toMatchObject({ candidates: 3, embedded: 3, cacheHits: 0, requests: 3 });
  });

  it("keeps vectors L2-normalized and aligned with the input order", async () => {
    const transport = fakeTransport({
      vector: ({ input }) => input.map((text) => (text.includes("alpha") ? [3, 4, 0, 0] : [0, 5, 0, 0])),
    });
    const embedder = new OpenRouterEmbedder(
      config({ EMBEDDING_MODEL: "custom/embed", EMBEDDING_FALLBACK_MODELS: "custom/embed" }),
      transport,
    );
    const result = await embedder.embed(["alpha", "beta"]);
    expect(result.dims).toBe(4);
    expect(vectorValues(result.vectors[0]!).map((value) => Number(value.toFixed(4)))).toEqual([0.6, 0.8, 0, 0]);
    expect(vectorValues(result.vectors[1]!).map((value) => Number(value.toFixed(4)))).toEqual([0, 1, 0, 0]);
  });

  it("batches one request when the profile allows maxBatch 10", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config({ EMBEDDING_MODEL: LLAMA }), transport);
    const result = await embedder.embed(["one", "two", "three"]);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.input).toEqual(["one", "two", "three"]);
    expect(result.dims).toBe(2048);
    expect(result.vectors).toHaveLength(3);
  });

  it("deduplicates identical texts before calling the API", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config({ EMBEDDING_MODEL: LLAMA }), transport);
    const result = await embedder.embed(["same text", "same text"]);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.input).toEqual(["same text"]);
    expect(vectorValues(result.vectors[0]!)).toEqual(vectorValues(result.vectors[1]!));
    expect(embedder.getStats()).toMatchObject({ candidates: 2, embedded: 2, cacheHits: 0 });
  });

  it("serializes requests for concurrency-1 fallback models", async () => {
    const transport = fakeTransport({
      delayMs: () => 5,
      vector: ({ input }) => input.map(() => Array.from({ length: 1024 }, (_value, index) => (index === 0 ? 1 : 0))),
    });
    const embedder = new OpenRouterEmbedder(config({ EMBEDDING_MODEL: BGE }), transport);
    const texts = Array.from({ length: 12 }, (_value, index) => `text ${index}`);
    await embedder.embed(texts);
    expect(transport.requests).toHaveLength(2);
    expect(transport.maxInFlight).toBe(1);
  });

  it("discovers vector dimensions for models without a profile", async () => {
    const transport = fakeTransport({
      vector: ({ input }) => input.map(() => [1, 0, 0]),
    });
    const embedder = new OpenRouterEmbedder(
      config({ EMBEDDING_MODEL: "custom/embed", EMBEDDING_FALLBACK_MODELS: "custom/embed" }),
      transport,
    );
    const result = await embedder.embed(["text"]);
    expect(result.dims).toBe(3);
    expect(result.vectors[0]).toHaveLength(3);
  });

  it("truncates texts to the profile character budget", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config(), transport);
    await embedder.embed(["x".repeat(5000)]);
    expect(transport.requests[0]?.input[0]).toHaveLength(2400);
  });

  it("uses the profile request timeout", async () => {
    const budget = { EMBEDDING_BUDGET_MS: "60000" };
    const primary = new OpenRouterEmbedder(config(budget), fakeTransport());
    await primary.embed(["text"]);
    const primaryTransport = fakeTransport();
    const primaryEmbedder = new OpenRouterEmbedder(config(budget), primaryTransport);
    await primaryEmbedder.embed(["text"]);
    expect(primaryTransport.requests[0]?.timeoutMs).toBe(8000);

    const llamaTransport = fakeTransport();
    await new OpenRouterEmbedder(config({ ...budget, EMBEDDING_MODEL: LLAMA }), llamaTransport).embed(["text"]);
    expect(llamaTransport.requests[0]?.timeoutMs).toBe(5000);

    const bgeTransport = fakeTransport();
    await new OpenRouterEmbedder(config({ ...budget, EMBEDDING_MODEL: BGE }), bgeTransport).embed(["text"]);
    expect(bgeTransport.requests[0]?.timeoutMs).toBe(8000);
  });

  it("returns empty vectors without requests for empty input", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config(), transport);
    const result = await embedder.embed(["", "  "]);
    expect(transport.requests).toHaveLength(0);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors.every((vector) => vector.length === 0)).toBe(true);
    expect(result.partial).toBe(false);
    expect(embedder.getStats().candidates).toBe(0);
  });

  it("handles an empty text array", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config(), transport);
    const result = await embedder.embed([]);
    expect(result.vectors).toEqual([]);
    expect(result.partial).toBe(false);
    expect(transport.requests).toHaveLength(0);
  });
});

describe("fallback chain", () => {
  it("falls back to the second model when the primary fails", async () => {
    const transport = fakeTransport({
      fail: ({ model }) => (model === PRIMARY
        ? new ProviderError("openrouter-embed", "network_error", "primary 502")
        : undefined),
    });
    const embedder = new OpenRouterEmbedder(config(), transport);
    const result = await embedder.embed(["text one", "text two"]);
    expect(result.model).toBe(LLAMA);
    expect(result.fallbackIndex).toBe(1);
    expect(result.dims).toBe(2048);
    expect(result.vectors.every((vector) => vector.length === 2048)).toBe(true);
    expect(transport.requests.filter((request) => request.model === LLAMA)).toHaveLength(1);
  });

  it("walks to the third model when the first two fail", async () => {
    const transport = fakeTransport({
      fail: ({ model }) => (model === BGE
        ? undefined
        : new ProviderError("openrouter-embed", "network_error", `${model} 502`)),
    });
    const embedder = new OpenRouterEmbedder(config(), transport);
    const result = await embedder.embed(["text"]);
    expect(result.model).toBe(BGE);
    expect(result.fallbackIndex).toBe(2);
    expect(result.dims).toBe(1024);
    expect(result.vectors[0]).toHaveLength(1024);
  });

  it("switches the whole operation and never mixes dimensions", async () => {
    const transport = fakeTransport({
      fail: ({ model, input }) => (model === PRIMARY && input.some((text) => text.includes("BAD"))
        ? new ProviderError("openrouter-embed", "network_error", "502 on one chunk")
        : undefined),
    });
    const embedder = new OpenRouterEmbedder(config(), transport);
    const result = await embedder.embed(["good text", "BAD text"]);

    expect(result.model).toBe(LLAMA);
    expect(result.fallbackIndex).toBe(1);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors.every((vector) => vector.length === 2048)).toBe(true);
    const fallbackTexts = transport.requests
      .filter((request) => request.model === LLAMA)
      .flatMap((request) => request.input)
      .sort();
    expect(fallbackTexts).toEqual(["BAD text", "good text"]);
    expect(result.partial).toBe(false);
  });

  it("throws a ProviderError only after every model fails", async () => {
    const transport = fakeTransport({
      fail: () => new ProviderError("openrouter-embed", "network_error", "deterministic 502"),
    });
    const embedder = new OpenRouterEmbedder(config(), transport);
    const error = await rejection(embedder.embed(["text"]));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "openrouter-embed", code: "network_error" });
    expect((error as Error).message).toContain(PRIMARY);
    expect((error as Error).message).toContain(LLAMA);
    expect((error as Error).message).toContain(BGE);
    expect(transport.requests.map((request) => request.model)).toEqual([PRIMARY, LLAMA, BGE]);
  });

  it("fails fast with missing_credential when no API key is configured", async () => {
    const embedder = new OpenRouterEmbedder(loadConfig({}));
    const error = await rejection(embedder.embed(["text"]));
    expect(error).toMatchObject({ provider: "openrouter-embed", code: "missing_credential" });
  });

  it("reports the circuit breaker state to semantic dedupe", () => {
    const open = fakeTransport();
    open.isCircuitOpen = () => true;
    const openEmbedder = new OpenRouterEmbedder(config(), open);
    expect(openEmbedder.isCircuitOpen()).toBe(true);
    expect(embedderCircuitOpen(openEmbedder)).toBe(true);

    const closed = fakeTransport();
    closed.isCircuitOpen = () => false;
    expect(embedderCircuitOpen(new OpenRouterEmbedder(config(), closed))).toBe(false);
    const legacy: Embedder = {
      async embed() {
        return { vectors: [], model: "fake", dims: 0, partial: false };
      },
    };
    expect(embedderCircuitOpen(legacy)).toBe(false);
  });
});

describe("vector cache", () => {
  it("serves repeated texts from cache without counting them as embedded", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config({ EMBEDDING_MODEL: LLAMA }), transport);
    const first = await embedder.embed(["cached text", "other text"]);
    expect(transport.requests).toHaveLength(1);
    expect(embedder.getStats()).toMatchObject({ candidates: 2, embedded: 2, cacheHits: 0 });

    const second = await embedder.embed(["cached text", "other text"]);
    expect(transport.requests).toHaveLength(1);
    expect(vectorValues(second.vectors[0]!)).toEqual(vectorValues(first.vectors[0]!));
    expect(embedder.getStats()).toMatchObject({ candidates: 2, embedded: 0, cacheHits: 2, requests: 0 });
    expect(second.partial).toBe(false);
  });

  it("keys the cache by model so another model never reuses cached vectors", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config(), transport);
    transport.failModels.add(PRIMARY);
    const fallback = await embedder.embed(["model scoped"]);
    expect(fallback.model).toBe(LLAMA);
    expect(embedder.getStats()).toMatchObject({ cacheHits: 0, embedded: 1 });

    transport.failModels.delete(PRIMARY);
    const primary = await embedder.embed(["model scoped"]);
    expect(primary.model).toBe(PRIMARY);
    expect(primary.fallbackIndex).toBeUndefined();
    expect(embedder.getStats()).toMatchObject({ cacheHits: 0, embedded: 1 });
    expect(transport.requests.at(-1)?.model).toBe(PRIMARY);
  });

  it("honours the cache TTL", async () => {
    const transport = fakeTransport({ delayMs: () => 0 });
    const embedder = new OpenRouterEmbedder(
      config({ EMBEDDING_MODEL: LLAMA, EMBEDDING_CACHE_TTL_MS: "1" }),
      transport,
    );
    await embedder.embed(["ttl text"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await embedder.embed(["ttl text"]);
    expect(transport.requests).toHaveLength(2);
  });

  it("honours the cache entry cap", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(
      config({ EMBEDDING_MODEL: LLAMA, EMBEDDING_CACHE_MAX_ENTRIES: "1" }),
      transport,
    );
    await embedder.embed(["text one", "text two"]);
    expect(transport.requests).toHaveLength(1);
    await embedder.embed(["text one", "text two"]);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.input).toEqual(["text one"]);
    expect(embedder.getStats().cacheHits).toBe(1);
  });
});

describe("global budget and partial results", () => {
  it("returns the vectors it already has when the budget expires mid-flight", async () => {
    const transport = fakeTransport({
      delayMs: ({ input }) => (input.some((text) => text.includes("SLOW")) ? 5000 : 0),
    });
    const embedder = new OpenRouterEmbedder(config({ EMBEDDING_BUDGET_MS: "120" }), transport);
    const startedAt = Date.now();
    const result = await embedder.embed(["fast text", "SLOW text"]);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2000);
    expect(result.partial).toBe(true);
    expect(result.model).toBe(PRIMARY);
    expect(result.vectors[0]?.length).toBe(4096);
    expect(result.vectors[1]?.length).toBe(0);
    expect(embedder.getStats()).toMatchObject({ candidates: 2, embedded: 1 });
  });

  it("propagates an aborted caller signal without issuing requests", async () => {
    const transport = fakeTransport();
    const embedder = new OpenRouterEmbedder(config(), transport);
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const error = await rejection(embedder.embed(["text"], controller.signal));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("timeout");
    expect(transport.requests).toHaveLength(0);
  });

  it("does not spend the remaining budget on a fallback model", async () => {
    const transport = fakeTransport({ delayMs: () => 5000 });
    const embedder = new OpenRouterEmbedder(config({ EMBEDDING_BUDGET_MS: "80" }), transport);
    const error = await rejection(embedder.embed(["slow one"]));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("timeout");
    expect(transport.requests.every((request) => request.model === PRIMARY)).toBe(true);
  });
});
