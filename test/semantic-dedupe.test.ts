import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import {
  cosineSimilarity,
  dedupeSourceIdentitiesSemantic,
  SEMANTIC_DEDUPE_MAX_TEXTS,
  type SemanticDedupeResult,
} from "../src/semantic-dedupe.js";
import { dedupeSourceIdentities, titleSimilarity } from "../src/source-identity.js";
import type { Embedder, EmbeddingStats } from "../src/providers/openrouter-embed.js";
import type { EmbeddingMode, SearchSource } from "../src/types.js";

interface FixtureSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  provider: string;
}

interface FixturePair {
  id: string;
  label: string;
  titleJaccard: number;
  cosine: number;
  left: FixtureSource;
  right: FixtureSource;
  leftVector: number[];
  rightVector: number[];
}

interface FixtureCase {
  id: string;
  threshold: number;
  sources: string[];
  extraSources?: FixtureSource[];
  vectors?: Record<string, number[]>;
  expect: {
    merged: boolean;
    mergedCount: number;
    semanticCopyCount: number;
    groups: number;
    keptUrl?: string;
    hosts?: string[];
    dateConflict?: boolean;
    keptSnippet?: string;
    candidates?: number;
  };
}

interface Fixture {
  dims: number;
  thresholds: Record<string, number>;
  pairs: FixturePair[];
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/semantic-pairs.json", import.meta.url), "utf8"),
) as Fixture;

function source(url: string, extra: Partial<SearchSource> = {}): SearchSource {
  return { url, provider: "tavily", ...extra };
}

function fixturePair(id: string): FixturePair {
  const pair = fixture.pairs.find((item) => item.id === id);
  if (pair === undefined) throw new Error(`unknown fixture pair: ${id}`);
  return pair;
}

function pairSources(id: string): SearchSource[] {
  const pair = fixturePair(id);
  return [
    { ...pair.left } as SearchSource,
    { ...pair.right } as SearchSource,
  ];
}

function pairVectors(id: string): Record<string, number[]> {
  const pair = fixturePair(id);
  return {
    [pair.left.url]: pair.leftVector,
    [pair.right.url]: pair.rightVector,
  };
}

interface FakeEmbedderOptions {
  vectors?: Record<string, number[]>;
  model?: string;
  dims?: number;
  partial?: boolean;
  fallbackIndex?: number;
  usage?: Record<string, unknown>;
  error?: Error;
  circuitOpen?: boolean;
  stats?: EmbeddingStats;
}

type FakeEmbedder = Embedder & {
  calls: string[][];
  isCircuitOpen(): boolean;
  getStats(): EmbeddingStats;
};

function fakeEmbedder(options: FakeEmbedderOptions = {}): FakeEmbedder {
  const calls: string[][] = [];
  const vectorsByUrl = options.vectors ?? {};
  const embedder: FakeEmbedder = {
    calls,
    isCircuitOpen: () => options.circuitOpen === true,
    getStats(): EmbeddingStats {
      if (options.stats !== undefined) return options.stats;
      const last = calls[calls.length - 1] ?? [];
      return {
        candidates: last.length,
        embedded: last.length,
        cacheHits: 0,
        requests: last.length,
      };
    },
    async embed(texts: string[]) {
      calls.push([...texts]);
      if (options.error !== undefined) throw options.error;
      const vectors = texts.map((text) => {
        const url = Object.keys(vectorsByUrl).find((candidate) => text.includes(candidate));
        const values = url === undefined ? [] : vectorsByUrl[url]!;
        return Float32Array.from(values);
      });
      const first = vectors.find((vector) => vector.length > 0);
      const result: Awaited<ReturnType<Embedder["embed"]>> = {
        vectors,
        model: options.model ?? "fake-embed",
        dims: options.dims ?? first?.length ?? fixture.dims,
        partial: options.partial ?? false,
      };
      if (options.fallbackIndex !== undefined) result.fallbackIndex = options.fallbackIndex;
      if (options.usage !== undefined) result.usage = options.usage;
      return result;
    },
  };
  return embedder;
}

interface RunOptions {
  mode: EmbeddingMode;
  threshold?: number;
  maxPairs?: number;
  crossHost?: boolean;
  embedder: Embedder;
}

function run(sources: SearchSource[], options: RunOptions): Promise<SemanticDedupeResult> {
  return dedupeSourceIdentitiesSemantic(sources, {
    crossHost: options.crossHost ?? true,
    mode: options.mode,
    threshold: options.threshold ?? 0.55,
    maxPairs: options.maxPairs ?? 8,
    embedder: options.embedder,
    now: new Date("2026-11-10T00:00:00Z"),
  });
}

async function runCase(
  testCase: FixtureCase,
  embedder?: Embedder,
): Promise<{ result: SemanticDedupeResult; embedder: FakeEmbedder }> {
  const sources: SearchSource[] = testCase.sources.map((reference) => {
    const [pairId, side] = reference.split(":") as [string, "left" | "right"];
    const pair = fixturePair(pairId);
    return { ...pair[side] } as SearchSource;
  });
  for (const extra of testCase.extraSources ?? []) sources.push({ ...extra } as SearchSource);
  const vectors: Record<string, number[]> = {};
  for (const reference of testCase.sources) {
    const [pairId, side] = reference.split(":") as [string, "left" | "right"];
    const pair = fixturePair(pairId);
    vectors[pair[side].url] = side === "left" ? pair.leftVector : pair.rightVector;
  }
  Object.assign(vectors, testCase.vectors ?? {});
  const fake = embedder === undefined
    ? fakeEmbedder({ vectors })
    : (embedder as FakeEmbedder);
  const result = await run(sources, {
    mode: "on",
    threshold: testCase.threshold,
    embedder: fake,
  });
  return { result, embedder: fake };
}

function plannedPairs(): SearchSource[] {
  const sources: SearchSource[] = [];
  for (let index = 0; index < 5; index += 1) {
    sources.push(source(`https://alpha${index}.example.com/notes-${index}-release`, {
      title: `Syndication${index} release notes what changed`,
    }));
    sources.push(source(`https://beta${index}.example.com/recap-${index}-release`, {
      title: `Syndication${index} release recap for developers`,
    }));
  }
  return sources;
}

function plannedVectors(sources: SearchSource[]): Record<string, number[]> {
  const vectors: Record<string, number[]> = {};
  for (const item of sources) vectors[item.url] = [1, 0, 0, 0];
  return vectors;
}

describe("cosine similarity", () => {
  it("matches the hand-authored cosines in the fixture", () => {
    for (const pair of fixture.pairs) {
      const left = Float32Array.from(pair.leftVector);
      const right = Float32Array.from(pair.rightVector);
      expect(cosineSimilarity(left, right)).toBeCloseTo(pair.cosine, 6);
    }
  });

  it("returns 1 for identical, 0 for orthogonal and -1 for opposite vectors", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0, 0, 0]), Float32Array.from([1, 0, 0, 0]))).toBe(1);
    expect(cosineSimilarity(Float32Array.from([1, 0, 0, 0]), Float32Array.from([0, 1, 0, 0]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0, 0, 0]), Float32Array.from([-1, 0, 0, 0]))).toBe(-1);
  });

  it("is a true cosine for unnormalized vectors", () => {
    expect(cosineSimilarity(Float32Array.from([3, 4, 0, 0]), Float32Array.from([3, 4, 0, 0]))).toBe(1);
  });

  it("rejects empty, zero and dimension-mismatched vectors", () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0, 0]), new Float32Array(3))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
});

describe("title band assumptions", () => {
  it("matches the declared title Jaccard values in the fixture", () => {
    for (const pair of fixture.pairs) {
      const similarity = titleSimilarity(
        { ...pair.left } as SearchSource,
        { ...pair.right } as SearchSource,
      );
      expect(similarity).toBeCloseTo(pair.titleJaccard, 6);
    }
  });
});

describe("mode off", () => {
  const sources = [
    source("https://techsy.io/it/deepseek-release-notes-explained", { title: "DeepSeek release notes explained" }),
    source("https://techsy.io/en/deepseek-release-notes-explained", { title: "DeepSeek release notes explained" }),
    source("https://api-docs.deepseek.com/news/release", { title: "DeepSeek official release notes" }),
  ];

  it("returns the lexical result byte-identically", async () => {
    const embedder = fakeEmbedder({ vectors: pairVectors("gray-band-merge") });
    const result = await run(sources, { mode: "off", embedder });
    const lexical = dedupeSourceIdentities(sources, { crossHost: true });
    expect(JSON.stringify(result.sources)).toBe(JSON.stringify(lexical.sources));
    expect(result.sources).toEqual(lexical.sources);
    expect(embedder.calls).toHaveLength(0);
  });

  it("reports mode off with no candidates and no merge attribution", async () => {
    const result = await run(sources, { mode: "off", embedder: fakeEmbedder() });
    const lexical = dedupeSourceIdentities(sources, { crossHost: true });
    expect(result.report).toMatchObject({
      mode: "off",
      applied: false,
      candidates: 0,
      embedded: 0,
      mergedPairs: 0,
      partial: false,
      circuitOpen: false,
    });
    expect(result.mergedCount).toBe(lexical.mergedCount);
    expect(result.semanticCopyCount).toBe(0);
    expect(result.groups).toEqual([]);
    expect(typeof result.report.elapsedMs).toBe("number");
  });

  it("honours crossHost=false byte-identically", async () => {
    const embedder = fakeEmbedder();
    const result = await run(sources, { mode: "off", crossHost: false, embedder });
    const lexical = dedupeSourceIdentities(sources, { crossHost: false });
    expect(JSON.stringify(result.sources)).toBe(JSON.stringify(lexical.sources));
    expect(embedder.calls).toHaveLength(0);
  });
});

describe("mode shadow", () => {
  it("computes similarity without changing the sources", async () => {
    const embedder = fakeEmbedder({ vectors: pairVectors("gray-band-merge") });
    const sources = pairSources("gray-band-merge");
    const result = await run(sources, { mode: "shadow", threshold: 0.55, embedder });
    const lexical = dedupeSourceIdentities(sources, { crossHost: true });

    expect(result.sources).toEqual(lexical.sources);
    expect(result.report).toMatchObject({
      mode: "shadow",
      applied: false,
      mergedPairs: 0,
      wouldMerge: 1,
      candidates: 2,
      embedded: 2,
      partial: false,
    });
    expect(result.report.model).toBe("fake-embed");
    expect(result.report.dims).toBe(4);
    expect(result.semanticCopyCount).toBe(0);
    expect(result.groups).toEqual([]);
    expect(embedder.calls).toHaveLength(1);
  });

  it("reports wouldMerge relative to the threshold", async () => {
    const sources = pairSources("threshold-band");
    const low = await run(sources, {
      mode: "shadow",
      threshold: 0.55,
      embedder: fakeEmbedder({ vectors: pairVectors("threshold-band") }),
    });
    const high = await run(sources, {
      mode: "shadow",
      threshold: 0.62,
      embedder: fakeEmbedder({ vectors: pairVectors("threshold-band") }),
    });
    expect(low.report.wouldMerge).toBe(1);
    expect(high.report.wouldMerge).toBe(0);
    expect(low.sources).toEqual(high.sources);
  });

  it("never merges even when a pair is above the threshold", async () => {
    const sources = pairSources("gray-band-merge");
    const result = await run(sources, {
      mode: "shadow",
      threshold: 0.55,
      embedder: fakeEmbedder({ vectors: pairVectors("gray-band-merge") }),
    });
    const lexical = dedupeSourceIdentities(sources, { crossHost: true });
    expect(result.sources).toHaveLength(lexical.sources.length);
    expect(result.mergedCount).toBe(0);
  });
});

describe("mode on", () => {
  for (const testCase of fixture.cases) {
    it(`matches fixture case ${testCase.id}`, async () => {
      const { result, embedder } = await runCase(testCase);
      const expectation = testCase.expect;
      if (expectation.merged) {
        expect(result.semanticCopyCount).toBe(expectation.semanticCopyCount);
        expect(result.report.mergedPairs).toBe(expectation.semanticCopyCount);
        expect(result.report.applied).toBe(true);
      } else {
        expect(result.semanticCopyCount).toBe(0);
        expect(result.report.mergedPairs).toBe(0);
      }
      expect(result.mergedCount).toBe(expectation.mergedCount);
      expect(result.groups).toHaveLength(expectation.groups);
      if (expectation.candidates === 0) expect(embedder.calls).toHaveLength(0);
      if (expectation.merged) {
        expect(result.groups[0]?.reason).toBe("semantic-syndication");
        if (expectation.keptUrl !== undefined) {
          expect(result.sources[0]?.url).toBe(expectation.keptUrl);
          expect(result.groups[0]?.keptUrl).toBe(expectation.keptUrl);
        }
        if (expectation.hosts !== undefined) {
          expect([...(result.groups[0]?.hosts ?? [])].sort()).toEqual([...expectation.hosts].sort());
        }
        if (expectation.dateConflict !== undefined) {
          expect(result.groups[0]?.dateConflict).toBe(expectation.dateConflict);
        }
        if (expectation.keptSnippet !== undefined) {
          expect(result.sources[0]?.snippet).toBe(expectation.keptSnippet);
        }
        expect(result.report.mergedPairs).toBeGreaterThan(0);
        expect(result.report.partial).toBe(false);
        expect(result.report.circuitOpen).toBe(false);
        expect(result.report.model).toBe("fake-embed");
        expect(result.report.dims).toBe(4);
        expect(typeof result.report.elapsedMs).toBe("number");
      }
    });
  }

  it("merges a pair whose cosine exactly equals the threshold", async () => {
    const sources = pairSources("threshold-band");
    const result = await run(sources, {
      mode: "on",
      threshold: 0.6,
      embedder: fakeEmbedder({ vectors: pairVectors("threshold-band") }),
    });
    expect(result.semanticCopyCount).toBe(1);
    expect(result.report.mergedPairs).toBe(1);
  });

  it("keeps pairs below the threshold separate", async () => {
    const sources = pairSources("threshold-band");
    const result = await run(sources, {
      mode: "on",
      threshold: 0.62,
      embedder: fakeEmbedder({ vectors: pairVectors("threshold-band") }),
    });
    expect(result.semanticCopyCount).toBe(0);
    expect(result.report.applied).toBe(true);
    expect(result.sources).toHaveLength(2);
  });

  it("fills missing metadata without overwriting the kept copy", async () => {
    const sources = pairSources("metadata-fill");
    const result = await run(sources, {
      mode: "on",
      threshold: 0.55,
      embedder: fakeEmbedder({ vectors: pairVectors("metadata-fill") }),
    });
    const kept = result.sources[0];
    expect(kept?.url).toBe("https://api-docs.deepseek.com/resources/v32-notes");
    expect(kept?.title).toBe("DeepSeek V3.2 release notes: what changed");
    expect(kept?.snippet).toBe("Recap text that should fill the missing official snippet.");
    expect(result.groups[0]?.mergedUrls).toEqual([
      "https://ofox.ai/deepseek-v32-resources",
    ]);
  });

  it("never merges a semantic pair that would exceed the maxPairs cap", async () => {
    const sources = [
      ...pairSources("gray-band-merge"),
      ...pairSources("threshold-band"),
    ];
    const vectors = { ...pairVectors("gray-band-merge"), ...pairVectors("threshold-band") };
    const embedder = fakeEmbedder({ vectors });
    const result = await run(sources, { mode: "on", threshold: 0.55, maxPairs: 1, embedder });
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]).toHaveLength(2);
    expect(result.semanticCopyCount).toBe(1);
    expect(result.report.candidates).toBe(2);
  });

  it("does nothing when maxPairs is zero", async () => {
    const sources = pairSources("gray-band-merge");
    const embedder = fakeEmbedder({ vectors: pairVectors("gray-band-merge") });
    const result = await run(sources, { mode: "on", maxPairs: 0, embedder });
    expect(embedder.calls).toHaveLength(0);
    expect(result.semanticCopyCount).toBe(0);
    expect(result.sources).toEqual(sources);
  });

  it(`caps embedded texts at ${SEMANTIC_DEDUPE_MAX_TEXTS}`, async () => {
    const sources = plannedPairs();
    const embedder = fakeEmbedder({ vectors: plannedVectors(sources) });
    const result = await run(sources, {
      mode: "on",
      threshold: 0.55,
      maxPairs: 8,
      embedder,
    });
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]).toHaveLength(SEMANTIC_DEDUPE_MAX_TEXTS);
    expect(result.semanticCopyCount).toBe(4);
    expect(result.report.candidates).toBe(SEMANTIC_DEDUPE_MAX_TEXTS);
    expect(result.sources).toHaveLength(6);
  });

  it("does not merge across hosts when crossHost is disabled", async () => {
    const sources = pairSources("gray-band-merge");
    const embedder = fakeEmbedder({ vectors: pairVectors("gray-band-merge") });
    const result = await run(sources, { mode: "on", crossHost: false, embedder });
    expect(embedder.calls).toHaveLength(0);
    expect(result.report.candidates).toBe(0);
    expect(result.report.applied).toBe(false);
    expect(result.sources).toEqual(sources);
  });

  it("handles empty and single-source inputs without embedding", async () => {
    const embedder = fakeEmbedder();
    const empty = await run([], { mode: "on", embedder });
    expect(empty.sources).toEqual([]);
    expect(empty.report.candidates).toBe(0);
    const single = await run([source("https://example.com/only")], { mode: "on", embedder });
    expect(single.sources).toHaveLength(1);
    expect(single.report.candidates).toBe(0);
    expect(embedder.calls).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("falls back to the lexical result when the embedder throws", async () => {
    const sources = pairSources("gray-band-merge");
    const embedder = fakeEmbedder({ error: new ProviderError("openrouter-embed", "network_error", "deterministic 502") });
    const result = await run(sources, { mode: "on", threshold: 0.55, embedder });
    const lexical = dedupeSourceIdentities(sources, { crossHost: true });

    expect(result.sources).toEqual(lexical.sources);
    expect(result.mergedCount).toBe(lexical.mergedCount);
    expect(result.semanticCopyCount).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.report).toMatchObject({
      mode: "on",
      applied: false,
      embedded: 0,
      mergedPairs: 0,
      partial: true,
      circuitOpen: false,
      candidates: 2,
    });
  });

  it("surfaces an open circuit in the report", async () => {
    const sources = pairSources("gray-band-merge");
    const embedder = fakeEmbedder({
      error: new ProviderError("openrouter-embed", "network_error", "circuit breaker is open"),
      circuitOpen: true,
    });
    const result = await run(sources, { mode: "on", embedder });
    expect(result.report.applied).toBe(false);
    expect(result.report.circuitOpen).toBe(true);
    expect(result.report.partial).toBe(true);
  });

  it("only merges pairs whose vectors are both available", async () => {
    const sources = pairSources("gray-band-merge");
    const vectors = { [fixturePair("gray-band-merge").left.url]: [1, 0, 0, 0] };
    const embedder = fakeEmbedder({ vectors, partial: true });
    const result = await run(sources, { mode: "on", embedder });
    expect(result.report.partial).toBe(true);
    expect(result.semanticCopyCount).toBe(0);
    expect(result.sources).toHaveLength(2);
  });

  it("reports cache hits separately from embedded texts", async () => {
    const sources = pairSources("gray-band-merge");
    const embedder = fakeEmbedder({
      vectors: pairVectors("gray-band-merge"),
      stats: { candidates: 2, embedded: 0, cacheHits: 2, requests: 0 },
    });
    const result = await run(sources, { mode: "on", embedder });
    expect(result.report.candidates).toBe(2);
    expect(result.report.embedded).toBe(0);
    expect(result.semanticCopyCount).toBe(1);
    expect(result.report.partial).toBe(false);
  });

  it("propagates model and fallback information from the embedder", async () => {
    const sources = pairSources("gray-band-merge");
    const embedder = fakeEmbedder({
      vectors: pairVectors("gray-band-merge"),
      model: "nvidia/llama-nemotron-embed-vl-1b-v2:free",
      dims: 2048,
      fallbackIndex: 1,
      usage: { prompt_tokens: 10 },
    });
    const result = await run(sources, { mode: "on", embedder });
    expect(result.report.model).toBe("nvidia/llama-nemotron-embed-vl-1b-v2:free");
    expect(result.report.dims).toBe(2048);
    expect(result.report.fallbackIndex).toBe(1);
    expect(result.report.usage).toEqual({ prompt_tokens: 10 });
  });
});

describe("interaction with the lexical pass", () => {
  it("re-runs the lexical pass after semantic metadata fill", async () => {
    const sharedSnippet = "DeepSeek released new benchmark numbers for its latest model and published migration notes for developers.";
    const primary = source("https://alpha-news.example.com/post-slug-12345", {
      title: "DeepSeek V3.2 release overview",
      provider: "tavily",
    });
    const syndicated = source("https://b.example.com/other-path-999", {
      title: "DeepSeek release notes analysis",
      snippet: sharedSnippet,
      provider: "searxng",
    });
    const laterCopy = source("https://gamma-wire.example.net/post-slug-12345", {
      title: "DeepSeek V3.2 release notes analysis",
      snippet: sharedSnippet,
      provider: "anysearch",
    });
    const embedder = fakeEmbedder({
      vectors: {
        [primary.url]: [1, 0, 0, 0],
        [syndicated.url]: [0.8, 0.6, 0, 0],
      },
    });
    const lexical = dedupeSourceIdentities([primary, syndicated, laterCopy], { crossHost: true });
    expect(lexical.mergedCount).toBe(0);

    const result = await run([primary, syndicated, laterCopy], {
      mode: "on",
      threshold: 0.55,
      embedder,
    });
    expect(result.semanticCopyCount).toBe(1);
    expect(result.mergedCount).toBe(2);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe(primary.url);
    expect(result.sources[0]?.snippet).toBe(sharedSnippet);
  });

  it("operates on the lexically deduped source list", async () => {
    const english = source("https://techsy.io/en/deepseek-release-notes", {
      title: "DeepSeek V3.2 release notes: what changed",
      provider: "tavily",
    });
    const italian = source("https://techsy.io/it/deepseek-release-notes", {
      title: "Note di rilascio DeepSeek V3.2",
      provider: "tavily",
    });
    const syndicated = source("https://ofox.ai/deepseek-v32-launch-recap", {
      title: "DeepSeek V3.2 release recap for developers",
      provider: "searxng",
    });
    const embedder = fakeEmbedder({
      vectors: {
        [english.url]: [1, 0, 0, 0],
        [syndicated.url]: [0.9, 0.4358898943540674, 0, 0],
      },
    });
    const result = await run([english, italian, syndicated], {
      mode: "on",
      threshold: 0.55,
      embedder,
    });
    // The language variant is removed by the lexical pass before candidates exist.
    expect(embedder.calls[0]).toHaveLength(2);
    expect(result.semanticCopyCount).toBe(1);
    expect(result.mergedCount).toBe(2);
    expect(result.sources).toHaveLength(1);
  });
});
