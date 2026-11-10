import { hostClass, hostKey, isLowAuthorityHost } from "./hosts.js";
import {
  embedderCircuitOpen,
  type Embedder,
  type EmbeddingStats,
} from "./providers/openrouter-embed.js";
import {
  dedupeSourceIdentities,
  parseSourceUrl,
  titleSimilarity,
  type ParsedSourceUrl,
} from "./source-identity.js";
import type { EmbeddingMode, EmbeddingReport, SearchSource } from "./types.js";

/**
 * Semantic syndication dedupe is deliberately narrow: it only repairs the gap
 * the lexical heuristic leaves behind, i.e. copies whose titles are related
 * but not similar enough (Jaccard in the "gray band") for the slug/title rule
 * in source-identity.ts to fire. It never ranks or filters sources.
 */

/** Lower bound (inclusive) of the title-Jaccard gray band. */
const TITLE_BAND_MIN = 0.25;
/** Upper bound (exclusive) of the title-Jaccard gray band. */
const TITLE_BAND_MAX = 0.6;
/** Hard cap on source texts embedded per call (small on purpose). */
export const SEMANTIC_DEDUPE_MAX_TEXTS = 8;

export interface SemanticDedupeGroup {
  keptUrl: string;
  mergedUrls: string[];
  hosts: string[];
  reason: "semantic-syndication";
  dateConflict: boolean;
}

export interface SemanticDedupeOptions {
  /** Enable cross-host candidate pairs (the whole point of semantic syndication). */
  crossHost: boolean;
  mode: EmbeddingMode;
  /** Fallback cosine threshold when thresholdForModel is absent. */
  threshold: number;
  /** Resolve the threshold from the model that actually produced the vectors. */
  thresholdForModel?: (model: string) => number;
  /** Maximum number of pairs to evaluate/merge (default 8 in config). */
  maxPairs: number;
  embedder: Embedder;
  /** Reserved for deterministic date math in callers/tests. */
  now?: Date;
  /** Optional cancellation forwarded to the embedder. */
  signal?: AbortSignal;
}

export interface SemanticDedupeResult {
  sources: SearchSource[];
  report: EmbeddingReport;
  /** Duplicates removed by lexical+semantic dedupe combined. */
  mergedCount: number;
  /** Subset of mergedCount attributable to semantic (syndication) merges. */
  semanticCopyCount: number;
  groups: SemanticDedupeGroup[];
}

interface ScoredPair {
  left: number;
  right: number;
  titleSimilarity: number;
  cosine: number;
}

interface MergeOutcome {
  sources: SearchSource[];
  semanticCopyCount: number;
  mergedPairs: number;
  groups: SemanticDedupeGroup[];
}

/**
 * Dot product of two L2-normalized vectors, computed defensively as a true
 * cosine so hand-authored/legacy vectors that are not exactly unit length
 * still behave predictably. Returns 0 for empty or dimension-mismatched input.
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftSquared += a * a;
    rightSquared += b * b;
  }
  if (leftSquared === 0 || rightSquared === 0) return 0;
  const value = dot / Math.sqrt(leftSquared * rightSquared);
  return Math.max(-1, Math.min(1, value));
}

function embeddingText(source: SearchSource): string {
  return [source.title, source.snippet, source.url]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

function publishedTimestamp(source: SearchSource): number | undefined {
  if (source.publishedAt === undefined) return undefined;
  const parsed = Date.parse(source.publishedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function datesConflict(left: SearchSource, right: SearchSource): boolean {
  const leftTime = publishedTimestamp(left);
  const rightTime = publishedTimestamp(right);
  if (leftTime === undefined || rightTime === undefined) return false;
  return Math.abs(leftTime - rightTime) > 24 * 60 * 60 * 1000;
}

/**
 * Authority risk used to pick the surviving copy: primary/reference hosts win
 * over unknown hosts, and aggregators/content farms always lose. Ties keep the
 * earlier result so ranking order is not disturbed more than necessary.
 */
function authorityRisk(url: string): number {
  if (isLowAuthorityHost(url)) return 2;
  const classification = hostClass(url);
  if (classification === "primary" || classification === "reference") return 0;
  if (classification === "unknown") return 1;
  return 2;
}

function fillMissingMetadata(kept: SearchSource, duplicate: SearchSource): void {
  if (kept.title === undefined && duplicate.title !== undefined) kept.title = duplicate.title;
  if (kept.snippet === undefined && duplicate.snippet !== undefined) kept.snippet = duplicate.snippet;
  if (kept.publishedAt === undefined && duplicate.publishedAt !== undefined) {
    kept.publishedAt = duplicate.publishedAt;
  }
  if (kept.score === undefined && duplicate.score !== undefined) kept.score = duplicate.score;
}

interface CandidatePair {
  left: number;
  right: number;
  titleSimilarity: number;
}

/**
 * Candidate generation happens on the already lexically-deduped source list:
 * every pair has a different host, a different slug, and a title similarity in
 * [0.25, 0.6). Pairs are sorted by title similarity (most promising first) so
 * the pair cap keeps the best candidates.
 */
function candidatePairs(sources: SearchSource[], crossHost: boolean): CandidatePair[] {
  if (!crossHost || sources.length < 2) return [];
  const parsed: Array<ParsedSourceUrl | null> = sources.map((source) => parseSourceUrl(source.url));
  const pairs: CandidatePair[] = [];
  for (let left = 0; left < sources.length; left += 1) {
    const leftParsed = parsed[left];
    if (leftParsed === null || leftParsed === undefined) continue;
    for (let right = left + 1; right < sources.length; right += 1) {
      const rightParsed = parsed[right];
      if (rightParsed === null || rightParsed === undefined) continue;
      if (leftParsed.host === rightParsed.host) continue;
      // Same slug is the lexical syndicated-copy heuristic's job, not ours.
      if (leftParsed.slug === rightParsed.slug) continue;
      const similarity = titleSimilarity(sources[left]!, sources[right]!);
      if (similarity < TITLE_BAND_MIN || similarity >= TITLE_BAND_MAX) continue;
      pairs.push({ left, right, titleSimilarity: similarity });
    }
  }
  pairs.sort(
    (a, b) => b.titleSimilarity - a.titleSimilarity || a.left - b.left || a.right - b.right,
  );
  return pairs;
}

interface PairSelection {
  pairs: CandidatePair[];
  indices: number[];
}

/**
 * Caps both the pair count and the number of distinct texts (max 8) that will
 * be embedded; a pair is only selected when both endpoints fit the text cap.
 */
function selectPairs(pairs: CandidatePair[], maxPairs: number): PairSelection {
  const cap = Math.max(0, Math.floor(maxPairs));
  const selected: CandidatePair[] = [];
  const indices = new Set<number>();
  if (cap === 0) return { pairs: selected, indices: [] };
  for (const pair of pairs) {
    if (selected.length >= cap) break;
    const extra = (indices.has(pair.left) ? 0 : 1) + (indices.has(pair.right) ? 0 : 1);
    if (indices.size + extra > SEMANTIC_DEDUPE_MAX_TEXTS) continue;
    selected.push(pair);
    indices.add(pair.left);
    indices.add(pair.right);
  }
  return { pairs: selected, indices: [...indices].sort((a, b) => a - b) };
}

function mergeSemanticPairs(base: SearchSource[], qualifying: ScoredPair[]): MergeOutcome {
  const copies = base.map((source) => ({ ...source }));
  const parent = base.map((_source, index) => index);
  const alive = base.map(() => true);
  const members = base.map((): number[] => []);
  const conflict = base.map(() => false);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  let mergedPairs = 0;
  let semanticCopyCount = 0;
  for (const pair of qualifying) {
    const leftRoot = find(pair.left);
    const rightRoot = find(pair.right);
    if (leftRoot === rightRoot) continue;
    const leftRisk = authorityRisk(copies[leftRoot]!.url);
    const rightRisk = authorityRisk(copies[rightRoot]!.url);
    const keepLeft = leftRisk < rightRisk || (leftRisk === rightRisk && leftRoot < rightRoot);
    const keptRoot = keepLeft ? leftRoot : rightRoot;
    const lostRoot = keepLeft ? rightRoot : leftRoot;
    parent[lostRoot] = keptRoot;
    alive[lostRoot] = false;
    members[keptRoot]!.push(lostRoot, ...members[lostRoot]!);
    members[lostRoot] = [];
    if (conflict[lostRoot] === true || datesConflict(copies[keptRoot]!, copies[lostRoot]!)) {
      conflict[keptRoot] = true;
    }
    fillMissingMetadata(copies[keptRoot]!, copies[lostRoot]!);
    mergedPairs += 1;
    semanticCopyCount += 1;
  }
  const sources: SearchSource[] = [];
  const groups: SemanticDedupeGroup[] = [];
  for (let index = 0; index < copies.length; index += 1) {
    if (!alive[index]) continue;
    const kept = copies[index]!;
    sources.push(kept);
    const mergedIndices = members[index]!;
    if (mergedIndices.length === 0) continue;
    const mergedUrls = mergedIndices.map(
      (member) => parseSourceUrl(copies[member]!.url)?.canonical ?? copies[member]!.url,
    );
    const hosts = [
      ...new Set([
        hostKey(kept.url),
        ...mergedIndices.map((member) => hostKey(copies[member]!.url)),
      ]),
    ];
    groups.push({
      keptUrl: kept.url,
      mergedUrls,
      hosts,
      reason: "semantic-syndication",
      dateConflict: conflict[index] === true,
    });
  }
  return { sources, semanticCopyCount, mergedPairs, groups };
}

function readEmbeddingStats(
  embedder: Embedder,
  expectedTexts: number,
): EmbeddingStats | undefined {
  const candidate = embedder as { getStats?: unknown };
  if (typeof candidate.getStats !== "function") return undefined;
  try {
    const stats = (candidate.getStats as () => EmbeddingStats)();
    if (typeof stats?.candidates !== "number" || typeof stats.embedded !== "number") {
      return undefined;
    }
    // The stats must describe this call: one candidate per text, and every
    // candidate accounted for as embedded or cached. A shared embedder under
    // concurrent requests can report another run, so ignore inconsistent data.
    if (stats.candidates !== expectedTexts) return undefined;
    if (stats.embedded + stats.cacheHits !== stats.candidates) return undefined;
    return stats;
  } catch {
    return undefined;
  }
}

interface ReportOverrides {
  applied?: boolean;
  model?: string;
  dims?: number;
  candidates?: number;
  embedded?: number;
  mergedPairs?: number;
  partial?: boolean;
  fallbackIndex?: number;
  circuitOpen?: boolean;
  usage?: Record<string, unknown>;
  wouldMerge?: number;
}

function buildReport(
  mode: EmbeddingMode,
  elapsedMs: number,
  overrides: ReportOverrides = {},
): EmbeddingReport {
  const report: EmbeddingReport = {
    mode,
    applied: overrides.applied ?? false,
    candidates: overrides.candidates ?? 0,
    embedded: overrides.embedded ?? 0,
    mergedPairs: overrides.mergedPairs ?? 0,
    partial: overrides.partial ?? false,
    circuitOpen: overrides.circuitOpen ?? false,
    elapsedMs,
  };
  if (overrides.model !== undefined) report.model = overrides.model;
  if (overrides.dims !== undefined) report.dims = overrides.dims;
  if (overrides.fallbackIndex !== undefined) report.fallbackIndex = overrides.fallbackIndex;
  if (overrides.usage !== undefined) report.usage = overrides.usage;
  if (overrides.wouldMerge !== undefined) report.wouldMerge = overrides.wouldMerge;
  return report;
}

/**
 * Lexical dedupe plus opt-in semantic syndication dedupe.
 *
 * - mode "off": byte-identical to dedupeSourceIdentities (no embedding work).
 * - mode "shadow": computes cosine similarity and reports wouldMerge, but the
 *   returned sources are exactly the lexical result.
 * - mode "on": merges only gray-band pairs whose cosine >= threshold, keeping
 *   the lower-authority-risk copy and filling only missing metadata; the
 *   lexical pass is re-run afterwards so the two dedupe layers stay consistent.
 *
 * Any embedding failure falls back to the lexical result with applied:false.
 */
export async function dedupeSourceIdentitiesSemantic(
  sources: SearchSource[],
  options: SemanticDedupeOptions,
): Promise<SemanticDedupeResult> {
  const startedAt = performance.now();
  const lexical = dedupeSourceIdentities(sources, { crossHost: options.crossHost });
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  if (options.mode === "off") {
    return {
      sources: lexical.sources,
      report: buildReport("off", elapsed()),
      mergedCount: lexical.mergedCount,
      semanticCopyCount: 0,
      groups: [],
    };
  }
  if (!options.crossHost) {
    return {
      sources: lexical.sources,
      report: buildReport(options.mode, elapsed()),
      mergedCount: lexical.mergedCount,
      semanticCopyCount: 0,
      groups: [],
    };
  }

  const pairs = candidatePairs(lexical.sources, options.crossHost);
  const selection = selectPairs(pairs, options.maxPairs);
  if (selection.pairs.length === 0) {
    return {
      sources: lexical.sources,
      report: buildReport(options.mode, elapsed()),
      mergedCount: lexical.mergedCount,
      semanticCopyCount: 0,
      groups: [],
    };
  }

  const texts = selection.indices.map((index) => embeddingText(lexical.sources[index]!));
  let embedded: Awaited<ReturnType<Embedder["embed"]>>;
  try {
    embedded = await options.embedder.embed(texts, options.signal);
  } catch {
    return {
      sources: lexical.sources,
      report: buildReport(options.mode, elapsed(), {
        partial: true,
        circuitOpen: embedderCircuitOpen(options.embedder),
        candidates: texts.length,
      }),
      mergedCount: lexical.mergedCount,
      semanticCopyCount: 0,
      groups: [],
    };
  }

  const effectiveThreshold = options.thresholdForModel?.(embedded.model)
    ?? options.threshold;
  const vectors = new Map<number, Float32Array>();
  let vectorDims: number | undefined;
  selection.indices.forEach((sourceIndex, position) => {
    const vector = embedded.vectors[position];
    if (vector === undefined || vector.length === 0) return;
    if (vectorDims === undefined) vectorDims = vector.length;
    if (vector.length !== vectorDims) return;
    vectors.set(sourceIndex, vector);
  });
  const stats = readEmbeddingStats(options.embedder, texts.length);
  const candidates = stats?.candidates ?? texts.length;
  const embeddedCount = stats?.embedded ?? vectors.size;
  const partial = embedded.partial || vectors.size < selection.indices.length;
  const dims = embedded.dims > 0 ? embedded.dims : vectorDims;
  const circuitOpen = embedderCircuitOpen(options.embedder);
  const baseOverrides: ReportOverrides = {
    candidates,
    embedded: embeddedCount,
    partial,
    circuitOpen,
    model: embedded.model,
  };
  if (dims !== undefined && dims > 0) baseOverrides.dims = dims;
  if (embedded.fallbackIndex !== undefined) baseOverrides.fallbackIndex = embedded.fallbackIndex;
  if (embedded.usage !== undefined) baseOverrides.usage = embedded.usage;

  const scored: Array<ScoredPair | { left: number; right: number; titleSimilarity: number; cosine: undefined }> =
    selection.pairs.map((pair) => {
      const leftVector = vectors.get(pair.left);
      const rightVector = vectors.get(pair.right);
      const cosine = leftVector !== undefined && rightVector !== undefined
        ? cosineSimilarity(leftVector, rightVector)
        : undefined;
      return { ...pair, cosine };
    });

  if (options.mode === "shadow") {
    const wouldMerge = scored.filter(
      (pair) => pair.cosine !== undefined && pair.cosine >= effectiveThreshold,
    ).length;
    return {
      sources: lexical.sources,
      report: buildReport("shadow", elapsed(), {
        ...baseOverrides,
        applied: false,
        mergedPairs: 0,
        wouldMerge,
      }),
      mergedCount: lexical.mergedCount,
      semanticCopyCount: 0,
      groups: [],
    };
  }

  const qualifying = scored
    .filter((pair): pair is ScoredPair => pair.cosine !== undefined && pair.cosine >= effectiveThreshold)
    .sort((a, b) => b.cosine - a.cosine || a.left - b.left || a.right - b.right);
  const merged = mergeSemanticPairs(lexical.sources, qualifying);
  const rerun = dedupeSourceIdentities(merged.sources, { crossHost: options.crossHost });
  return {
    sources: rerun.sources,
    report: buildReport("on", elapsed(), {
      ...baseOverrides,
      applied: vectors.size > 0,
      mergedPairs: merged.mergedPairs,
    }),
    mergedCount: lexical.mergedCount + merged.semanticCopyCount + rerun.mergedCount,
    semanticCopyCount: merged.semanticCopyCount,
    groups: merged.groups,
  };
}
