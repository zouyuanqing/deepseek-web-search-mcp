#!/usr/bin/env node
/**
 * scripts/eval/replay.mjs - offline replay of the v1.7.0 eval fixtures. No network.
 *
 * Reads test/fixtures/{rerank-cases,decisions-docs-intent,semantic-capture}.json,
 * imports the built dist modules, and writes work/eval/report.json + a markdown summary.
 *
 * Sections:
 *   rerank    2x2 {old,new} x {raw,minmax} through dist/ranking.js fuseRankings (which owns
 *             calibration via dist/rerank-calibration.js). Metrics: fused nDCG@5, top-1
 *             relevance/strict, provider coverage in top-5, top-1 protected rate, calibration
 *             applied/weak rates.
 *   decisions production-faithful docs-intent veto: the model may only act when the regex
 *             (ranking.hasOfficialIntent) is positive; p < 0.25 vetoes, p > 0.40 keeps, the
 *             0.25-0.40 dead band falls back to the regex. Metrics on applicable (regex-positive)
 *             cases: decisive precision/recall, veto false negatives, dead-band count, plus a
 *             regex-only baseline and a regex-independent classifier view.
 *   semantic  recorded 8b cosines vs labelled duplicate/distinct pairs at the three embedding
 *             profile thresholds 0.55/0.62/0.72 plus the shipped profile default.
 *
 * Exit codes: 0 = report written; 2 = a fixture is missing/unreadable or ranking dist is absent.
 * Acceptance thresholds live in scripts/eval/accept.mjs, not here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const ROOT = new URL("../../", import.meta.url);
const FIXTURES = new URL("test/fixtures/", ROOT);
const REPORT_DIR = new URL("work/eval/", ROOT);

const RERANK_MODELS = {
  old: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
  new: "nvidia/nemotron-3.5-rerank-8b:free",
};
const NORMALIZATIONS = ["raw", "minmax"];
const SEMANTIC_THRESHOLDS = [0.55, 0.62, 0.72];
// Dead-band boundaries are imported from dist/docs-intent.js at run time (never hardcoded),
// so replay always evaluates the shipped policy.

function round(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : round(numerator / denominator);
}

async function readFixture(name) {
  try {
    const raw = await readFile(new URL(name, FIXTURES), "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

async function optionalModule(relative) {
  try {
    return { module: await import(new URL(relative, ROOT)) };
  } catch (error) {
    return { module: null, error: error && error.message ? error.message : String(error) };
  }
}

async function moduleText(relative) {
  try {
    return await readFile(new URL(relative, ROOT), "utf8");
  } catch {
    return "";
  }
}

function labelsOf(caseItem) {
  const labels = {};
  for (const candidate of caseItem.candidates ?? []) {
    if (typeof candidate.label === "number") labels[candidate.url] = candidate.label;
  }
  return labels;
}

function dcg(sources, labels, limit) {
  return sources.slice(0, limit).reduce((sum, source, index) => {
    const gain = labels[source.url] ?? 0;
    return sum + ((2 ** gain) - 1) / Math.log2(index + 2);
  }, 0);
}

function idealDcg(labels, limit) {
  return Object.values(labels).sort((left, right) => right - left).slice(0, limit)
    .reduce((sum, gain, index) => sum + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
}

function ndcg(sources, labels, limit) {
  const ideal = idealDcg(labels, limit);
  return ideal === 0 ? 0 : dcg(sources, labels, limit) / ideal;
}

function sourceMetrics(sources, labels) {
  const top5 = sources.slice(0, 5);
  const first = sources[0];
  const top1Label = first === undefined ? 0 : (labels[first.url] ?? 0);
  return {
    ndcg5: round(ndcg(sources, labels, 5)),
    ndcg10: round(ndcg(sources, labels, 10)),
    top1Relevant: top1Label > 0,
    top1Strict: top1Label >= 2,
    providerCoverageTop5: new Set(top5.map((source) => source.provider)).size,
    distinctDomainsTop5: new Set(top5.map((source) => {
      try {
        return new URL(source.url).hostname;
      } catch {
        return source.url;
      }
    })).size,
  };
}

// ---------------------------------------------------------------------------------------------
// Rerank
// ---------------------------------------------------------------------------------------------
async function rerankSection(fixture, rankingModule) {
  const calibration = await optionalModule("dist/rerank-calibration.js");
  const calibrationModule = calibration.module;

  const variants = {};
  for (const modelKey of ["old", "new"]) {
    for (const normalization of NORMALIZATIONS) {
      const key = modelKey + "-" + normalization;
      const perCase = [];
      let missing = 0;
      let calibrationApplied = 0;
      let calibrationWeak = 0;
      for (const caseItem of fixture.cases ?? []) {
        const recorded = caseItem.recorded?.[modelKey];
        const labels = labelsOf(caseItem);
        if (!recorded || recorded.status !== "ok" || Object.keys(recorded.scores ?? {}).length === 0 || Object.keys(labels).length === 0) {
          missing += 1;
          continue;
        }
        const rerankSources = (caseItem.candidates ?? [])
          .filter((candidate) => typeof recorded.scores[candidate.url] === "number")
          .sort((left, right) => recorded.scores[right.url] - recorded.scores[left.url] || left.url.localeCompare(right.url))
          .map((candidate) => ({
            url: candidate.url,
            title: candidate.title,
            snippet: candidate.snippet,
            provider: candidate.provider,
            rerankScore: recorded.scores[candidate.url],
          }));
        if (rerankSources.length === 0) {
          missing += 1;
          continue;
        }
        try {
          const fused = rankingModule.fuseRankings(caseItem.query, caseItem.candidates, rerankSources, {
            rerankModel: recorded.model ?? RERANK_MODELS[modelKey],
            rerankNormalization: normalization,
          });
          if (fused.calibration?.applied === true) calibrationApplied += 1;
          if (fused.calibration?.signalQuality === "weak") calibrationWeak += 1;
          perCase.push({
            id: caseItem.id,
            category: caseItem.category,
            ...sourceMetrics(fused.sources, labels),
            top1Protected: fused.top1Protected === true,
            officialIntent: fused.officialIntent === true,
          });
        } catch {
          missing += 1;
        }
      }
      const includedIds = new Set(perCase.map((item) => item.id));
      const baseline = (fixture.cases ?? [])
        .filter((caseItem) => includedIds.has(caseItem.id))
        .map((caseItem) => sourceMetrics(caseItem.candidates ?? [], labelsOf(caseItem)));
      variants[key] = {
        model: modelKey,
        modelId: RERANK_MODELS[modelKey],
        normalization,
        cases: perCase.length,
        missing,
        calibrationAppliedRate: ratio(calibrationApplied, perCase.length),
        calibrationWeakRate: ratio(calibrationWeak, perCase.length),
        meanNdcg5: round(average(perCase.map((item) => item.ndcg5))),
        meanNdcg10: round(average(perCase.map((item) => item.ndcg10))),
        top1RelevantRate: round(average(perCase.map((item) => (item.top1Relevant ? 1 : 0)))),
        top1StrictRate: round(average(perCase.map((item) => (item.top1Strict ? 1 : 0)))),
        meanProviderCoverageTop5: round(average(perCase.map((item) => item.providerCoverageTop5))),
        meanDistinctDomainsTop5: round(average(perCase.map((item) => item.distinctDomainsTop5))),
        top1ProtectedRate: round(average(perCase.map((item) => (item.top1Protected ? 1 : 0)))),
        baselineMeanNdcg5: round(average(baseline.map((item) => item.ndcg5))),
        baselineMeanDistinctDomainsTop5: round(average(baseline.map((item) => item.distinctDomainsTop5))),
        perCase,
      };
    }
  }

  const scoreStats = {};
  for (const modelKey of ["old", "new"]) {
    const all = [];
    const relevant = [];
    const irrelevant = [];
    for (const caseItem of fixture.cases ?? []) {
      const recorded = caseItem.recorded?.[modelKey];
      if (!recorded || recorded.status !== "ok") continue;
      for (const candidate of caseItem.candidates ?? []) {
        const score = recorded.scores?.[candidate.url];
        if (typeof score !== "number") continue;
        all.push(score);
        if ((candidate.label ?? 0) >= 2) relevant.push(score);
        else irrelevant.push(score);
      }
    }
    scoreStats[modelKey] = {
      samples: all.length,
      min: all.length > 0 ? round(Math.min(...all)) : null,
      max: all.length > 0 ? round(Math.max(...all)) : null,
      meanRelevant: relevant.length > 0 ? round(average(relevant)) : null,
      meanIrrelevant: irrelevant.length > 0 ? round(average(irrelevant)) : null,
      aboveLegacyFloor: all.filter((score) => score > 0.35).length,
    };
  }
  for (const modelKey of ["old", "new"]) {
    const values = (fixture.cases ?? [])
      .map((caseItem) => caseItem.recorded?.[modelKey]?.elapsedMs)
      .filter((value) => typeof value === "number" && value > 0);
    scoreStats[modelKey].latencyP50 = round(percentile(values, 0.5), 0);
    scoreStats[modelKey].latencyP95 = round(percentile(values, 0.95), 0);
    scoreStats[modelKey].latencySamples = values.length;
  }

  // Paired comparison: variants can cover different case counts (a model call may be
  // skipped), so a delta is only computed on the intersection of their case ids.
  const baselineByCase = new Map(
    (fixture.cases ?? []).map((caseItem) => [caseItem.id, sourceMetrics(caseItem.candidates ?? [], labelsOf(caseItem))]),
  );
  const pairedComparison = (leftKey, rightKey) => {
    const left = variants[leftKey];
    const right = variants[rightKey];
    const rightById = new Map(right.perCase.map((item) => [item.id, item]));
    const common = left.perCase.filter((item) => rightById.has(item.id));
    if (common.length === 0) return { cases: 0, left: null, right: null, delta: null, baseline: null };
    const leftValue = average(common.map((item) => item.ndcg5));
    const rightValue = average(common.map((item) => rightById.get(item.id).ndcg5));
    return {
      cases: common.length,
      left: round(leftValue),
      right: round(rightValue),
      delta: round(rightValue - leftValue),
      baseline: round(average(common.map((item) => baselineByCase.get(item.id)?.ndcg5 ?? 0))),
    };
  };

  return {
    paired: {
      "old-raw-vs-old-minmax": pairedComparison("old-raw", "old-minmax"),
      "old-raw-vs-new-raw": pairedComparison("old-raw", "new-raw"),
      "new-raw-vs-new-minmax": pairedComparison("new-raw", "new-minmax"),
      "old-raw-vs-new-minmax": pairedComparison("old-raw", "new-minmax"),
    },
    fixture: { capturedAt: fixture.capturedAt, cases: (fixture.cases ?? []).length, models: fixture.models },
    modules: {
      rerankCalibration: calibrationModule !== null,
      rerankCalibrationError: calibration.error,
      fusionOptionsSupported: true,
    },
    scoreStats,
    baseline: {
      meanNdcg5: round(average((fixture.cases ?? []).map((caseItem) => sourceMetrics(caseItem.candidates ?? [], labelsOf(caseItem)).ndcg5))),
      meanDistinctDomainsTop5: round(average((fixture.cases ?? []).map((caseItem) => sourceMetrics(caseItem.candidates ?? [], labelsOf(caseItem)).distinctDomainsTop5))),
    },
    variants,
  };
}

// ---------------------------------------------------------------------------------------------
// Decisions (production-faithful docs-intent veto)
// ---------------------------------------------------------------------------------------------
function decisionsSection(fixture, rankingModule, policy, productionQuestion) {
  const hasOfficialIntent = typeof rankingModule.hasOfficialIntent === "function" ? rankingModule.hasOfficialIntent : () => false;
  const vetoBelow = policy.vetoBelow;
  const keepAbove = policy.keepAbove;
  const rows = [];
  let missing = 0;

  for (const caseItem of fixture.cases ?? []) {
    const runs = (caseItem.runs ?? []).filter((run) => run.status === "ok" && typeof run.probability === "number");
    if (runs.length === 0) {
      missing += 1;
      continue;
    }
    const probabilities = runs.map((run) => run.probability);
    const p = average(probabilities);
    const spread = Math.max(...probabilities) - Math.min(...probabilities);
    const regexOfficialIntent = hasOfficialIntent(caseItem.query) === true;
    const gold = caseItem.gold === true;
    // Production semantics: the model is only consulted when the regex is positive,
    // it can veto below 0.25, keep above 0.40, and the dead band resolves to the regex.
    const applicable = regexOfficialIntent;
    const inDeadBand = p >= vetoBelow && p <= keepAbove;
    const modelVerdict = p < vetoBelow ? "veto" : p > keepAbove ? "keep" : "fallback";
    const resolvedDocs = !applicable ? false : p < vetoBelow ? false : true;
    const decisive = applicable && modelVerdict !== "fallback";
    rows.push({
      id: caseItem.id,
      category: caseItem.category,
      query: caseItem.query,
      gold,
      p: round(p),
      spread: round(spread),
      regexOfficialIntent,
      applicable,
      decisive,
      inDeadBand,
      modelVerdict,
      resolvedDocs,
      correct: resolvedDocs === gold,
      annotations: round(average(runs.map((run) => run.annotations ?? 0)), 1),
      latencyMs: round(average(runs.map((run) => run.elapsedMs ?? 0)), 0),
      runs: runs.length,
    });
  }

  function confusion(subset) {
    const positives = subset.filter((row) => row.gold);
    const negatives = subset.filter((row) => !row.gold);
    const tp = positives.filter((row) => row.resolvedDocs).length;
    const fn = positives.filter((row) => !row.resolvedDocs).length;
    const fp = negatives.filter((row) => row.resolvedDocs).length;
    const tn = negatives.filter((row) => !row.resolvedDocs).length;
    return { tp, fp, fn, tn, positives: positives.length, negatives: negatives.length };
  }
  function scores(counts) {
    return {
      tp: counts.tp,
      fp: counts.fp,
      fn: counts.fn,
      tn: counts.tn,
      precision: ratio(counts.tp, counts.tp + counts.fp),
      recall: ratio(counts.tp, counts.tp + counts.fn),
      accuracy: ratio(counts.tp + counts.tn, counts.tp + counts.fp + counts.fn + counts.tn),
      vetoPrecision: ratio(counts.tn, counts.tn + counts.fn),
      vetoRecall: ratio(counts.tn, counts.tn + counts.fp),
      vetoFn: counts.fn,
    };
  }

  const applicableRows = rows.filter((row) => row.applicable);
  const decisiveRows = rows.filter((row) => row.decisive);
  const applicableScores = scores(confusion(applicableRows));
  const decisiveScores = scores(confusion(decisiveRows));
  const regexCounts = {
    tp: applicableRows.filter((row) => row.gold && row.regexOfficialIntent).length,
    fp: applicableRows.filter((row) => !row.gold && row.regexOfficialIntent).length,
    fn: 0,
    tn: 0,
  };
  const regexScores = scores(regexCounts);

  // Regex-independent classifier view over every labelled query.
  const classifierRows = rows.map((row) => {
    const predicted = row.p > keepAbove ? true : row.p < vetoBelow ? false : row.regexOfficialIntent;
    return { ...row, predicted, classifierCorrect: predicted === row.gold };
  });
  const classifierCounts = {
    tp: classifierRows.filter((row) => row.gold && row.predicted).length,
    fp: classifierRows.filter((row) => !row.gold && row.predicted).length,
    fn: classifierRows.filter((row) => row.gold && !row.predicted).length,
    tn: classifierRows.filter((row) => !row.gold && !row.predicted).length,
  };

  const latencyValues = rows.map((row) => row.latencyMs).filter((value) => typeof value === "number");
  return {
    fixture: { capturedAt: fixture.capturedAt, model: fixture.model, cases: (fixture.cases ?? []).length, repeats: fixture.repeats },
    policy: {
      vetoBelow,
      keepAbove,
      deadBand: [vetoBelow, keepAbove],
      source: policy.source,
    },
    // Drift guards: the fixture must have been recorded against the current production prompt.
    prompt: {
      promptVersion: fixture.promptVersion ?? null,
      expectedPromptVersion: policy.promptVersion,
      promptVersionMatch: fixture.promptVersion === policy.promptVersion,
      questionHash: fixture.questionHash ?? null,
      expectedQuestionHash: policy.expectedQuestionHash,
      questionHashMatch: fixture.questionHash === null
        ? null
        : fixture.questionHash === policy.expectedQuestionHash,
      promptSource: fixture.promptSource ?? null,
      recordedQuestion: fixture.question ?? null,
      expectedQuestion: productionQuestion,
    },
    counts: {
      applicable: applicableRows.length,
      decisive: decisiveRows.length,
      deadBand: rows.filter((row) => row.inDeadBand).length,
      outOfScopeRegexNegativeDocs: rows.filter((row) => row.gold && !row.regexOfficialIntent).length,
      missing,
    },
    decisive: decisiveScores,
    applicable: applicableScores,
    regexBaseline: { ...regexScores, tp: regexCounts.tp, fp: regexCounts.fp },
    classifier: { ...scores(classifierCounts), tp: classifierCounts.tp, fp: classifierCounts.fp, fn: classifierCounts.fn, tn: classifierCounts.tn },
    spread: {
      mean: round(average(rows.map((row) => row.spread))),
      max: round(Math.max(...rows.map((row) => row.spread))),
    },
    annotations: { mean: round(average(rows.map((row) => row.annotations)), 1), samples: rows.length },
    latency: { p50: round(percentile(latencyValues, 0.5), 0), p95: round(percentile(latencyValues, 0.95), 0) },
    byCategory: Object.fromEntries([...new Set(rows.map((row) => row.category))].map((category) => {
      const subset = rows.filter((row) => row.category === category);
      return [category, {
        cases: subset.length,
        correct: subset.filter((row) => row.correct).length,
        meanP: round(average(subset.map((row) => row.p))),
      }];
    })),
    rows: classifierRows,
  };
}

// ---------------------------------------------------------------------------------------------
// Semantic pairs
// ---------------------------------------------------------------------------------------------
function semanticSection(fixture, embedModule) {
  const pairs = (fixture.pairs ?? []).filter((pair) => pair.status === "ok" && typeof pair.cosine === "number");
  const missing = (fixture.pairs ?? []).length - pairs.length;
  const duplicatePairs = pairs.filter((pair) => pair.label === "duplicate");
  const distinctPairs = pairs.filter((pair) => pair.label === "distinct");

  const evaluate = (threshold) => {
    const tp = duplicatePairs.filter((pair) => pair.cosine >= threshold).length;
    const fn = duplicatePairs.length - tp;
    const fp = distinctPairs.filter((pair) => pair.cosine >= threshold).length;
    const tn = distinctPairs.length - fp;
    return {
      threshold,
      tp,
      fp,
      fn,
      tn,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      fpr: ratio(fp, fp + tn),
      accuracy: ratio(tp + tn, tp + fp + fn + tn),
      duplicateCount: duplicatePairs.length,
      distinctCount: distinctPairs.length,
    };
  };
  const thresholds = SEMANTIC_THRESHOLDS.map(evaluate);

  let shippedThreshold = null;
  let thresholdSource = "unavailable";
  try {
    const resolveProfile = embedModule?.resolveProfile;
    const model = fixture.model;
    if (typeof resolveProfile === "function" && typeof model === "string") {
      const profile = resolveProfile(model);
      if (profile !== null && typeof profile === "object" && typeof profile.threshold === "number") {
        shippedThreshold = profile.threshold;
        thresholdSource = "dist/providers/openrouter-embed.js profile " + model;
      }
    }
  } catch {
    // ignore; report unavailable
  }
  const shipped = shippedThreshold === null ? null : evaluate(shippedThreshold);

  const recallByVariant = {};
  for (const variant of [...new Set(duplicatePairs.map((pair) => pair.variant))]) {
    const subset = duplicatePairs.filter((pair) => pair.variant === variant);
    recallByVariant[variant] = { cases: subset.length, cosines: subset.map((pair) => pair.cosine) };
  }
  const distinctByVariant = {};
  for (const variant of [...new Set(distinctPairs.map((pair) => pair.variant))]) {
    const subset = distinctPairs.filter((pair) => pair.variant === variant);
    distinctByVariant[variant] = {
      cases: subset.length,
      maxCosine: round(Math.max(...subset.map((pair) => pair.cosine))),
      meanCosine: round(average(subset.map((pair) => pair.cosine))),
    };
  }

  return {
    fixture: {
      capturedAt: fixture.capturedAt,
      model: fixture.model,
      dimension: (fixture.texts ?? []).find((item) => typeof item.dimension === "number")?.dimension ?? null,
      texts: (fixture.texts ?? []).length,
    },
    totalPairs: (fixture.pairs ?? []).length,
    comparedPairs: pairs.length,
    missing,
    thresholds,
    shippedThreshold,
    shippedThresholdSource: thresholdSource,
    shipped,
    separability: {
      minDuplicateCosine: duplicatePairs.length === 0 ? null : round(Math.min(...duplicatePairs.map((pair) => pair.cosine))),
      maxDistinctCosine: distinctPairs.length === 0 ? null : round(Math.max(...distinctPairs.map((pair) => pair.cosine))),
      margin: duplicatePairs.length === 0 || distinctPairs.length === 0
        ? null
        : round(Math.min(...duplicatePairs.map((pair) => pair.cosine)) - Math.max(...distinctPairs.map((pair) => pair.cosine))),
    },
    recallByVariant,
    distinctByVariant,
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
const rerankFixture = await readFixture("rerank-cases.json");
const decisionsFixture = await readFixture("decisions-docs-intent.json");
const semanticFixture = await readFixture("semantic-capture.json");

const blocked = [];
for (const [name, fixture] of [
  ["test/fixtures/rerank-cases.json", rerankFixture],
  ["test/fixtures/decisions-docs-intent.json", decisionsFixture],
  ["test/fixtures/semantic-capture.json", semanticFixture],
]) {
  if (!fixture.ok) blocked.push({ fixture: name, error: fixture.error });
}

const rankingModule = await optionalModule("dist/ranking.js");
if (rankingModule.module === null) blocked.push({ fixture: "dist/ranking.js", error: rankingModule.error });
const embedModule = await optionalModule("dist/providers/openrouter-embed.js");
const docsIntentModule = await optionalModule("dist/docs-intent.js");
const decisionsProviderModule = await optionalModule("dist/providers/openrouter-decisions.js");
const semanticModule = await optionalModule("dist/semantic-dedupe.js");

// The decisions policy must be the shipped one: PROMPT_VERSION + dead-band boundaries from
// dist/docs-intent.js, and the exact production question copy from the decisions transport.
const productionQuestion = decisionsProviderModule.module?.DOCS_INTENT_QUESTION ?? null;
let decisionsPolicy = null;
if (docsIntentModule.module !== null && productionQuestion !== null) {
  const { PROMPT_VERSION, DECISIONS_VETO_BELOW, DECISIONS_KEEP_ABOVE } = docsIntentModule.module;
  if (
    typeof PROMPT_VERSION === "string"
    && typeof DECISIONS_VETO_BELOW === "number"
    && typeof DECISIONS_KEEP_ABOVE === "number"
  ) {
    decisionsPolicy = {
      promptVersion: PROMPT_VERSION,
      vetoBelow: DECISIONS_VETO_BELOW,
      keepAbove: DECISIONS_KEEP_ABOVE,
      source: "dist/docs-intent.js",
      expectedQuestionHash: sha256Json(productionQuestion),
    };
  }
}
if (decisionsPolicy === null) {
  blocked.push({
    fixture: "dist/docs-intent.js + dist/providers/openrouter-decisions.js",
    error: "PROMPT_VERSION / DECISIONS_VETO_BELOW / DECISIONS_KEEP_ABOVE / DOCS_INTENT_QUESTION missing; run npm run build",
  });
}

const report = {
  schemaVersion: 1,
  harness: "deepseek-web-search-mcp eval harness v1",
  generatedAt: new Date().toISOString(),
  fixtures: {
    rerank: { ok: rerankFixture.ok, cases: rerankFixture.data?.cases?.length ?? 0, capturedAt: rerankFixture.data?.capturedAt },
    decisions: { ok: decisionsFixture.ok, cases: decisionsFixture.data?.cases?.length ?? 0, capturedAt: decisionsFixture.data?.capturedAt },
    semantic: { ok: semanticFixture.ok, pairs: semanticFixture.data?.pairs?.length ?? 0, capturedAt: semanticFixture.data?.capturedAt },
  },
  modules: {
    ranking: rankingModule.module !== null,
    embedProvider: embedModule.module !== null,
    docsIntent: docsIntentModule.module !== null,
    decisionsProvider: decisionsProviderModule.module !== null,
    semanticDedupe: semanticModule.module !== null,
  },
  blocked,
  rerank: rerankFixture.ok && rankingModule.module !== null ? await rerankSection(rerankFixture.data, rankingModule.module) : null,
  decisions: decisionsFixture.ok && rankingModule.module !== null && decisionsPolicy !== null
    ? decisionsSection(decisionsFixture.data, rankingModule.module, decisionsPolicy, productionQuestion)
    : null,
  semantic: semanticFixture.ok ? semanticSection(semanticFixture.data, embedModule.module) : null,
};

await mkdir(REPORT_DIR, { recursive: true });
await writeFile(new URL("report.json", REPORT_DIR), JSON.stringify(report, null, 2) + "\n");

// ---------------------------------------------------------------------------------------------
// Markdown summary
// ---------------------------------------------------------------------------------------------
const lines = [];
lines.push("# v1.7.0 eval report (offline replay)");
lines.push("");
lines.push("Generated: " + report.generatedAt);
lines.push("");
if (blocked.length > 0) {
  lines.push("## BLOCKED");
  for (const item of blocked) lines.push("- " + item.fixture + ": " + item.error);
  lines.push("");
}
lines.push("## modules");
for (const [key, value] of Object.entries(report.modules)) lines.push("- " + key + ": " + (value ? "ok" : "missing"));
lines.push("");
if (report.rerank) {
  lines.push("## rerank (fused nDCG@5, " + report.rerank.fixture.cases + " cases)");
  lines.push("");
  lines.push("| variant | nDCG@5 | top1 rel | top1 strict | coverage | domains | top1 protected | calibration |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  lines.push("| baseline (no rerank) | " + report.rerank.baseline.meanNdcg5 + " | - | - | - | " + report.rerank.baseline.meanDistinctDomainsTop5 + " | - | - |");
  for (const [key, value] of Object.entries(report.rerank.variants)) {
    lines.push("| " + key + " (" + value.cases + " cases) | " + value.meanNdcg5 + " | " + value.top1RelevantRate + " | " + value.top1StrictRate + " | " + value.meanProviderCoverageTop5 + " | " + value.meanDistinctDomainsTop5 + " | " + value.top1ProtectedRate + " | applied " + value.calibrationAppliedRate + ", weak " + value.calibrationWeakRate + " |");
  }
  lines.push("");
  lines.push("Paired deltas (same case ids only):");
  lines.push("");
  lines.push("| comparison | cases | left nDCG@5 | right nDCG@5 | delta | baseline |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [name, value] of Object.entries(report.rerank.paired)) {
    lines.push("| " + name + " | " + value.cases + " | " + value.left + " | " + value.right + " | " + value.delta + " | " + value.baseline + " |");
  }
  lines.push("");
  for (const modelKey of ["old", "new"]) {
    const stats = report.rerank.scoreStats[modelKey];
    lines.push("- " + modelKey + " scores: min " + stats.min + ", max " + stats.max + ", mean relevant " + stats.meanRelevant + ", mean irrelevant " + stats.meanIrrelevant + ", above legacy floor 0.35: " + stats.aboveLegacyFloor + "/" + stats.samples + ", latency p50/p95 " + stats.latencyP50 + "/" + stats.latencyP95 + "ms");
  }
  lines.push("");
}
if (report.decisions) {
  const d = report.decisions;
  lines.push("## decisions docs-intent veto (" + d.fixture.cases + " cases, " + d.counts.applicable + " regex-positive, " + d.counts.decisive + " decisive)");
  lines.push("");
  lines.push("| view | precision | recall | veto-FN | accuracy |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  lines.push("| decisive (model acted) | " + d.decisive.precision + " | " + d.decisive.recall + " | " + d.decisive.vetoFn + " | " + d.decisive.accuracy + " |");
  lines.push("| applicable (dead band -> regex) | " + d.applicable.precision + " | " + d.applicable.recall + " | " + d.applicable.vetoFn + " | " + d.applicable.accuracy + " |");
  lines.push("| regex only | " + d.regexBaseline.precision + " | " + d.regexBaseline.recall + " | " + d.regexBaseline.vetoFn + " | " + d.regexBaseline.accuracy + " |");
  lines.push("| classifier (regex-independent) | " + d.classifier.precision + " | " + d.classifier.recall + " | " + d.classifier.fn + " | " + d.classifier.accuracy + " |");
  lines.push("");
  lines.push("dead band: " + d.counts.deadBand + " cases; out-of-scope regex-miss docs: " + d.counts.outOfScopeRegexNegativeDocs + "; p-spread mean/max " + d.spread.mean + "/" + d.spread.max + "; annotations mean " + d.annotations.mean + "; latency p50/p95 " + d.latency.p50 + "/" + d.latency.p95 + "ms");
  lines.push("prompt drift: fixture " + (d.prompt.promptVersion ?? "none") + " vs dist " + d.prompt.expectedPromptVersion + " -> version " + (d.prompt.promptVersionMatch ? "match" : "MISMATCH") + "; question hash " + (d.prompt.questionHashMatch === null ? "not recorded" : d.prompt.questionHashMatch ? "match" : "MISMATCH") + "; policy " + d.policy.source + " (veto<" + d.policy.vetoBelow + ", keep>" + d.policy.keepAbove + ")");
  lines.push("");
}
if (report.semantic) {
  const s = report.semantic;
  lines.push("## semantic pairs (" + s.comparedPairs + " pairs, dim " + s.fixture.dimension + ")");
  lines.push("");
  lines.push("| threshold | precision | recall | FPR | accuracy |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of s.thresholds) {
    const marker = s.shippedThreshold !== null && row.threshold === s.shippedThreshold ? " (shipped)" : "";
    lines.push("| " + row.threshold + marker + " | " + row.precision + " | " + row.recall + " | " + row.fpr + " | " + row.accuracy + " |");
  }
  lines.push("");
  lines.push("separability: min duplicate " + s.separability.minDuplicateCosine + ", max distinct " + s.separability.maxDistinctCosine + ", margin " + s.separability.margin);
  lines.push("shipped threshold: " + (s.shippedThreshold === null ? "unavailable" : s.shippedThreshold + " (" + s.shippedThresholdSource + ")") + (s.shipped === null ? "" : " -> precision " + s.shipped.precision + ", recall " + s.shipped.recall + ", FPR " + s.shipped.fpr));
  lines.push("");
}
lines.push("Report: work/eval/report.json");
process.stdout.write(lines.join("\n") + "\n");

if (blocked.length > 0) process.exit(2);
