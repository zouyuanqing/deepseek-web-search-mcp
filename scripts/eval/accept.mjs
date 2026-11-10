#!/usr/bin/env node
/**
 * scripts/eval/accept.mjs - acceptance gates for the v1.7.0 eval harness.
 *
 * Reads work/eval/report.json (produced by scripts/eval/replay.mjs) and applies the gate table
 * below. Writes work/eval/acceptance.json and prints a markdown table.
 *
 * Exit codes:
 *   0  all gates PASS
 *   1  at least one gate FAIL (a model/metric regressed against the recorded fixture)
 *   2  at least one gate BLOCKED (fixture or built module missing; nothing was measured)
 *
 * Gate table (v1.7.0):
 *   rerank     paired new-minmax fused nDCG@5 >= paired old-raw - 0.01  (deep non-inferiority)
 *   rerank     new-minmax mean provider coverage in top-5 > 0
 *   rerank     calibration module present and actually applied for new-minmax
 *   decisions  decisive veto false negatives == 0 (never veto a genuine docs query)
 *   decisions  decisive precision >= 0.95
 *   decisions  decisive recall >= 0.85
 *   semantic   some candidate threshold reaches precision >= 0.95, recall >= 0.80, FPR <= 0.03
 *
 * Informational rows never change the exit code: they surface the shipped embedding profile
 * threshold (which must be raised when it misses the semantic gates) and dead-band volume.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../../", import.meta.url);
const REPORT = new URL("work/eval/report.json", ROOT);
const OUTPUT = new URL("work/eval/acceptance.json", ROOT);

const THRESHOLDS = {
  rerank: {
    nonInferiorityDelta: -0.01,
    minCoverageTop5: 0,
    minPairedCases: 15,
    requireCalibrationApplied: true,
  },
  decisions: {
    precision: 0.95,
    recall: 0.85,
    vetoFn: 0,
    minDecisiveCases: 10,
  },
  semantic: {
    precision: 0.95,
    recall: 0.8,
    fpr: 0.03,
    minPairs: 20,
  },
};

let report;
try {
  report = JSON.parse(await readFile(REPORT, "utf8"));
} catch {
  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    overall: "blocked",
    error: "work/eval/report.json is missing; run: npm run eval:replay",
  }, null, 2) + "\n");
  process.exit(2);
}

const results = [];
function check(id, section, metric, value, threshold, verdict, detail) {
  results.push({ id, section, metric, value, threshold, status: verdict, ...(detail === undefined ? {} : { detail }) });
}
function pass(condition) {
  return condition ? "PASS" : "FAIL";
}
function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

// ---------------------------------------------------------------------------------------------
// rerank gates
// ---------------------------------------------------------------------------------------------
const rerank = report.rerank;
if (rerank === null || rerank === undefined) {
  for (const id of ["rerank.non-inferiority", "rerank.coverage", "rerank.calibration"]) {
    check(id, "rerank", "-", null, "-", "BLOCKED", "rerank fixture or dist/ranking.js unavailable");
  }
} else if (report.rerank?.modules?.rerankCalibration !== true) {
  for (const id of ["rerank.non-inferiority", "rerank.coverage", "rerank.calibration"]) {
    check(id, "rerank", "-", null, "-", "BLOCKED", "dist/rerank-calibration.js is missing; build the calibration module first");
  }
} else {
  const paired = rerank.paired?.["old-raw-vs-new-minmax"];
  const newMinmax = rerank.variants?.["new-minmax"];
  const oldRaw = rerank.variants?.["old-raw"];
  if (paired === undefined || newMinmax === undefined || oldRaw === undefined) {
    check("rerank.non-inferiority", "rerank", "paired nDCG@5", null, "-", "BLOCKED", "variant rows missing");
    check("rerank.coverage", "rerank", "coverage", null, "-", "BLOCKED", "variant rows missing");
    check("rerank.calibration", "rerank", "applied rate", null, "-", "BLOCKED", "variant rows missing");
  } else if ((paired.cases ?? 0) < THRESHOLDS.rerank.minPairedCases) {
    check("rerank.non-inferiority", "rerank", "paired cases", paired.cases, ">= " + THRESHOLDS.rerank.minPairedCases, "BLOCKED", "fixture incomplete");
    check("rerank.coverage", "rerank", "coverage", null, "-", "BLOCKED", "fixture incomplete");
    check("rerank.calibration", "rerank", "applied rate", null, "-", "BLOCKED", "fixture incomplete");
  } else {
    check(
      "rerank.non-inferiority",
      "rerank",
      "paired new-minmax - old-raw nDCG@5",
      paired.delta,
      ">= " + THRESHOLDS.rerank.nonInferiorityDelta,
      pass(typeof paired.delta === "number" && paired.delta >= THRESHOLDS.rerank.nonInferiorityDelta),
      "paired cases " + paired.cases + "; new-minmax " + paired.right + " vs old-raw " + paired.left + " (baseline " + paired.baseline + ")",
    );
    check(
      "rerank.coverage",
      "rerank",
      "new-minmax mean provider coverage top-5",
      newMinmax.meanProviderCoverageTop5,
      "> " + THRESHOLDS.rerank.minCoverageTop5,
      pass(typeof newMinmax.meanProviderCoverageTop5 === "number" && newMinmax.meanProviderCoverageTop5 > THRESHOLDS.rerank.minCoverageTop5),
      "raw new-raw coverage " + (rerank.variants?.["new-raw"]?.meanProviderCoverageTop5 ?? "-"),
    );
    const applied = newMinmax.calibrationAppliedRate;
    check(
      "rerank.calibration",
      "rerank",
      "new-minmax calibration applied rate",
      applied,
      "> 0",
      pass(THRESHOLDS.rerank.requireCalibrationApplied === false || (typeof applied === "number" && applied > 0)),
      "without calibration the compressed 3.5 scores make rerank a silent no-op",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// decisions gates
// ---------------------------------------------------------------------------------------------
const decisions = report.decisions;
if (decisions === null || decisions === undefined) {
  for (const id of [
    "decisions.prompt-version",
    "decisions.policy-source",
    "decisions.veto-fn",
    "decisions.precision",
    "decisions.recall",
  ]) {
    check(id, "decisions", "-", null, "-", "BLOCKED", "decisions fixture, dist/ranking.js or dist/docs-intent.js unavailable");
  }
} else {
  // The fixture must have been recorded against the exact shipped prompt; otherwise these
  // gates measure a variant of the veto rather than the production feature.
  const prompt = decisions.prompt ?? {};
  const promptVersionMatch = prompt.promptVersionMatch;
  const questionHashMatch = prompt.questionHashMatch;
  const promptStatus = promptVersionMatch === false || questionHashMatch === false
    ? "FAIL"
    : promptVersionMatch === true && questionHashMatch === true
      ? "PASS"
      : "BLOCKED";
  check(
    "decisions.prompt-version",
    "decisions",
    "fixture promptVersion vs dist PROMPT_VERSION",
    (prompt.promptVersion ?? "none") + " vs " + (prompt.expectedPromptVersion ?? "?"),
    "== " + (prompt.expectedPromptVersion ?? "dist PROMPT_VERSION"),
    promptStatus,
    questionHashMatch === false
      ? "question copy drifted from dist/providers/openrouter-decisions.js DOCS_INTENT_QUESTION; recapture decisions"
      : questionHashMatch === null
        ? "fixture has no questionHash (old-format fixture); recapture decisions"
        : "question copy hash matches the shipped DOCS_INTENT_QUESTION",
  );
  const policySource = decisions.policy?.source;
  check(
    "decisions.policy-source",
    "decisions",
    "dead-band constants source",
    policySource ?? null,
    "dist/docs-intent.js",
    policySource === "dist/docs-intent.js" ? "PASS" : "FAIL",
    "veto/keep boundaries must come from the shipped module, not a local copy",
  );
  const decisive = decisions.decisive ?? {};
  const decisiveCases = (decisive.tp ?? 0) + (decisive.fp ?? 0) + (decisive.fn ?? 0) + (decisive.tn ?? 0);
  if (decisiveCases < THRESHOLDS.decisions.minDecisiveCases) {
    for (const id of ["decisions.veto-fn", "decisions.precision", "decisions.recall"]) {
      check(id, "decisions", "decisive cases", decisiveCases, ">= " + THRESHOLDS.decisions.minDecisiveCases, "BLOCKED", "fixture incomplete");
    }
  } else {
    check(
      "decisions.veto-fn",
      "decisions",
      "decisive veto false negatives",
      decisive.vetoFn,
      "== " + THRESHOLDS.decisions.vetoFn,
      pass(decisive.vetoFn === THRESHOLDS.decisions.vetoFn),
      "gold documentation queries the model vetoed (dead band excluded)",
    );
    check(
      "decisions.precision",
      "decisions",
      "decisive precision",
      decisive.precision,
      ">= " + THRESHOLDS.decisions.precision,
      pass(typeof decisive.precision === "number" && decisive.precision >= THRESHOLDS.decisions.precision),
      "regex baseline precision " + (decisions.regexBaseline?.precision ?? "-") + "; applicable precision " + (decisions.applicable?.precision ?? "-"),
    );
    check(
      "decisions.recall",
      "decisions",
      "decisive recall",
      decisive.recall,
      ">= " + THRESHOLDS.decisions.recall,
      pass(typeof decisive.recall === "number" && decisive.recall >= THRESHOLDS.decisions.recall),
      "regex baseline recall " + (decisions.regexBaseline?.recall ?? "-"),
    );
  }
  check(
    "decisions.dead-band",
    "decisions",
    "dead-band cases",
    decisions.counts?.deadBand,
    "informational",
    "INFO",
    "resolved by the regex, not the model; out-of-scope regex-miss docs " + (decisions.counts?.outOfScopeRegexNegativeDocs ?? "-"),
  );
  check(
    "decisions.net-precision",
    "decisions",
    "applicable precision (shipped policy incl. dead band)",
    decisions.applicable?.precision,
    "informational; regex baseline " + (decisions.regexBaseline?.precision ?? "-"),
    "INFO",
    "user-visible precision after dead-band abstentions; dead band " + (decisions.counts?.deadBand ?? "-") + " case(s)",
  );
  check(
    "decisions.latency",
    "decisions",
    "p95 latency (ms)",
    decisions.latency?.p95,
    "informational (web-grounded, ~10 citations)",
    "INFO",
    "mean annotations " + (decisions.annotations?.mean ?? "-"),
  );
}

// ---------------------------------------------------------------------------------------------
// semantic gates
// ---------------------------------------------------------------------------------------------
const semantic = report.semantic;
if (semantic === null || semantic === undefined) {
  check("semantic.threshold", "semantic", "-", null, "-", "BLOCKED", "semantic fixture unavailable");
} else if ((semantic.comparedPairs ?? 0) < THRESHOLDS.semantic.minPairs) {
  check("semantic.threshold", "semantic", "pairs", semantic.comparedPairs, ">= " + THRESHOLDS.semantic.minPairs, "BLOCKED", "fixture incomplete");
} else {
  const qualifying = (semantic.thresholds ?? []).filter((row) =>
    typeof row.precision === "number" && row.precision >= THRESHOLDS.semantic.precision
    && typeof row.recall === "number" && row.recall >= THRESHOLDS.semantic.recall
    && typeof row.fpr === "number" && row.fpr <= THRESHOLDS.semantic.fpr);
  const best = qualifying.length > 0
    ? qualifying[0]
    : (semantic.thresholds ?? []).slice().sort((left, right) => ((right.precision ?? 0) + (right.recall ?? 0)) - ((left.precision ?? 0) + (left.recall ?? 0)))[0];
  check(
    "semantic.threshold",
    "semantic",
    "candidate threshold P/R/FPR",
    best === undefined ? null : best.threshold,
    "precision>=" + THRESHOLDS.semantic.precision + ", recall>=" + THRESHOLDS.semantic.recall + ", fpr<=" + THRESHOLDS.semantic.fpr,
    pass(qualifying.length > 0),
    best === undefined ? "no thresholds" : "P " + best.precision + " / R " + best.recall + " / FPR " + best.fpr + " at " + best.threshold,
  );
  const shipped = semantic.shipped;
  if (shipped === null || shipped === undefined) {
    check("semantic.shipped-threshold", "semantic", "shipped profile threshold", semantic.shippedThreshold ?? null, "informational", "INFO", "embedding profile threshold unavailable from dist");
  } else {
    const shippedOk = typeof shipped.precision === "number" && shipped.precision >= THRESHOLDS.semantic.precision
      && typeof shipped.recall === "number" && shipped.recall >= THRESHOLDS.semantic.recall
      && typeof shipped.fpr === "number" && shipped.fpr <= THRESHOLDS.semantic.fpr;
    check(
      "semantic.shipped-threshold",
      "semantic",
      "shipped threshold P/R/FPR",
      String(shipped.threshold) + " (" + (semantic.shippedThresholdSource ?? "?") + ")",
      "informational",
      "INFO",
      shippedOk
        ? "shipped threshold meets the gate"
        : "shipped profile threshold misses the gate (P " + shipped.precision + " / R " + shipped.recall + " / FPR " + shipped.fpr + "); raise the profile threshold to " + (best === undefined ? "the reported candidate" : best.threshold) + " before enabling semantic dedupe",
    );
  }
  check(
    "semantic.separability",
    "semantic",
    "min duplicate - max distinct cosine",
    semantic.separability?.margin,
    "> 0",
    "INFO",
    "negative margin means some distinct pair is closer than some duplicate pair",
  );
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
const gateResults = results.filter((item) => item.status !== "INFO");
const failed = gateResults.filter((item) => item.status === "FAIL");
const blockedGates = gateResults.filter((item) => item.status === "BLOCKED");
const overall = failed.length > 0 ? "fail" : blockedGates.length > 0 ? "blocked" : "pass";

const acceptance = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  harness: report.harness,
  thresholds: THRESHOLDS,
  source: {
    reportGeneratedAt: report.generatedAt,
    fixtures: report.fixtures,
    modules: report.modules,
  },
  results,
  summary: {
    pass: gateResults.filter((item) => item.status === "PASS").length,
    fail: failed.length,
    blocked: blockedGates.length,
    informational: results.filter((item) => item.status === "INFO").length,
  },
  overall,
  failedGates: failed.map((item) => item.id),
  blockedGates: blockedGates.map((item) => item.id),
};

await mkdir(new URL("work/eval/", ROOT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(acceptance, null, 2) + "\n");

const lines = [];
lines.push("# v1.7.0 eval acceptance");
lines.push("");
lines.push("| gate | section | metric | value | threshold | status | detail |");
lines.push("| --- | --- | --- | ---: | --- | --- | --- |");
for (const item of results) {
  lines.push("| " + [
    item.id,
    item.section,
    item.metric,
    item.value === null || item.value === undefined ? "-" : String(item.value),
    item.threshold,
    item.status,
    item.detail ?? "-",
  ].join(" | ") + " |");
}
lines.push("");
lines.push("Overall: **" + overall.toUpperCase() + "** (pass " + acceptance.summary.pass + ", fail " + acceptance.summary.fail + ", blocked " + acceptance.summary.blocked + ", info " + acceptance.summary.informational + ")");
lines.push("Reports: work/eval/acceptance.json, work/eval/report.json");
process.stdout.write(lines.join("\n") + "\n");

if (overall === "fail") process.exit(1);
if (overall === "blocked") process.exit(2);
process.exit(0);
