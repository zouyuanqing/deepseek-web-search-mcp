import type {
  RerankNormalization,
  RerankScoreReport,
  RerankSignalQuality,
} from "./types.js";

/** A rerank normalization mode after "auto" has been resolved to a concrete mode. */
export type ResolvedRerankMode = Exclude<RerankNormalization, "auto">;

/** Calibrated scores plus the report that explains how they were produced. */
export interface RerankCalibrationReport extends RerankScoreReport {
  /** Effective scores in the same order as the input raw scores (rerank result order). */
  scores: number[];
}

export const RERANK_OLD_MODEL_ID = "nvidia/llama-nemotron-rerank-vl-1b-v2";
export const RERANK_NEW_MODEL_ID = "nvidia/nemotron-3.5-rerank-8b";

/** Profile timeout for the pre-1.7 reranker (absolute scores, fast). */
export const RERANK_OLD_TIMEOUT_MS = 5_000;
/** Profile timeout for the 3.5 reranker (reasoning-heavy, slower). */
export const RERANK_NEW_TIMEOUT_MS = 12_000;

/** Below this many candidates min-max normalization carries no meaning. */
export const RERANK_MIN_NORMALIZATION_SAMPLES = 3;
/** A spread this small means the model output carries no ranking signal. */
export const RERANK_MIN_SPREAD = 0.02;
/** A maximum this low means the model output carries no relevance signal. */
export const RERANK_MIN_MAX_SCORE = 0.08;
/** Relative spread (spread / max) below which the signal is considered collapsed. */
export const RERANK_MIN_SPREAD_RATIO = 0.15;

/**
 * Normalize an OpenRouter model id so provider variants compare equal:
 * trims, lowercases, and strips a ":free" suffix and/or a trailing
 * "-YYYYMMDD" build date (in any order, repeatedly).
 */
export function normalizeRerankModelId(model: string): string {
  let normalized = model.trim().toLowerCase();
  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    if (normalized.endsWith(":free")) {
      normalized = normalized.slice(0, -":free".length).trim();
    }
    const buildDate = /-\d{8}$/u.exec(normalized);
    if (buildDate !== null) {
      normalized = normalized.slice(0, buildDate.index).trim();
    }
  }
  return normalized;
}

/**
 * Resolve the calibration profile for a rerank model.
 *
 * Known model families are calibrated per their published score distribution;
 * unknown models keep the pre-1.7 raw (absolute) behavior so a foreign score
 * scale is never amplified by guesswork.
 */
export function resolveRerankProfile(model: string): ResolvedRerankMode {
  const normalized = normalizeRerankModelId(model);
  if (normalized === RERANK_OLD_MODEL_ID) return "raw";
  if (normalized === RERANK_NEW_MODEL_ID) return "minmax";
  // Family fallback for date-qualified or provider-rewritten ids.
  if (normalized.includes("nemotron-3.5-rerank")) return "minmax";
  if (normalized.includes("llama-nemotron-rerank")) return "raw";
  return "raw";
}

/**
 * Resolve the rerank HTTP timeout: an explicit positive configured value wins,
 * otherwise the model profile decides (0 means "use the profile").
 */
export function resolveRerankTimeoutMs(model: string, configuredTimeoutMs: number): number {
  if (Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0) {
    return Math.round(configuredTimeoutMs);
  }
  return resolveRerankProfile(model) === "minmax"
    ? RERANK_NEW_TIMEOUT_MS
    : RERANK_OLD_TIMEOUT_MS;
}

function sanitizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

interface ScoreStats {
  min: number;
  max: number;
  spread: number;
}

function scoreStats(scores: readonly number[]): ScoreStats | undefined {
  if (scores.length === 0) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const score of scores) {
    if (score < min) min = score;
    if (score > max) max = score;
  }
  return { min, max, spread: max - min };
}

/**
 * Calibrate raw rerank scores into a comparable 0..1 scale.
 *
 * - raw: clamp to 0..1, no normalization.
 * - minmax: min-max normalize, but only when the score distribution proves it
 *   carries signal; compressed/saturated distribustions are zeroed and marked
 *   weak so rank fusion falls back to provider order instead of noise.
 * - auto: resolves the profile from the model.
 */
export function calibrateRerankScores(
  rawScores: number[],
  mode: RerankNormalization,
  model: string,
): RerankCalibrationReport {
  const scores = rawScores.map((score) => sanitizeScore(score));
  const resolvedMode: ResolvedRerankMode = mode === "auto"
    ? resolveRerankProfile(model)
    : mode;
  const stats = scoreStats(scores);
  const build = (
    applied: boolean,
    signalQuality: RerankSignalQuality,
    calibrated: number[],
  ): RerankCalibrationReport => ({
    mode: resolvedMode,
    applied,
    ...(stats === undefined
      ? {}
      : { rawMin: stats.min, rawMax: stats.max, spread: stats.spread }),
    signalQuality,
    scores: calibrated,
  });

  if (resolvedMode === "raw") {
    return build(false, "strong", scores);
  }
  // Too few candidates to normalize; behave exactly like the raw profile.
  if (scores.length < RERANK_MIN_NORMALIZATION_SAMPLES) {
    return build(false, "strong", scores);
  }
  if (stats === undefined) return build(false, "strong", scores);
  const { min, max, spread } = stats;
  if (new Set(scores).size < 2) {
    return build(false, "strong", scores);
  }
  if (
    spread < RERANK_MIN_SPREAD
    || max < RERANK_MIN_MAX_SCORE
    || spread / max < RERANK_MIN_SPREAD_RATIO
  ) {
    // Collapsed distribution: all-zero scores disable the dead absolute gates
    // while keeping the provider order intact.
    return build(false, "weak", scores.map(() => 0));
  }
  return build(
    true,
    "strong",
    scores.map((score) => sanitizeScore((score - min) / spread)),
  );
}
