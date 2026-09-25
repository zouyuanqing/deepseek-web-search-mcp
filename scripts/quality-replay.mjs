import { readFile, writeFile } from "node:fs/promises";
import { cleanFastSources, providerAwareRrf } from "../dist/quality.js";

const fixturePath = new URL("../work/quality/replay-fixture.json", import.meta.url);
const outputPath = new URL("../work/quality/baseline-report.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function dcg(sources, labels, limit) {
  return sources.slice(0, limit).reduce((sum, source, index) => {
    const gain = labels[source.url] ?? 0;
    return sum + ((2 ** gain) - 1) / Math.log2(index + 2);
  }, 0);
}

function idealDcg(labels, limit) {
  return Object.values(labels).sort((a, b) => b - a).slice(0, limit)
    .reduce((sum, gain, index) => sum + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
}

function metrics(sources, labels) {
  const ndcg5 = idealDcg(labels, 5) === 0 ? 0 : dcg(sources, labels, 5) / idealDcg(labels, 5);
  const ndcg10 = idealDcg(labels, 10) === 0 ? 0 : dcg(sources, labels, 10) / idealDcg(labels, 10);
  const firstRelevant = sources.findIndex((source) => (labels[source.url] ?? 0) > 0);
  return {
    ndcg5: Number(ndcg5.toFixed(4)),
    ndcg10: Number(ndcg10.toFixed(4)),
    mrr: firstRelevant < 0 ? 0 : Number((1 / (firstRelevant + 1)).toFixed(4)),
    top1Relevant: (labels[sources[0]?.url] ?? 0) > 0,
    providerCoverage: [...new Set(sources.map((source) => source.provider))].length,
    distinctDomains: [...new Set(sources.map((source) => {
      try { return new URL(source.url).hostname; } catch { return source.url; }
    }))].length,
    datedSourceRate: sources.length === 0
      ? 0
      : sources.filter((source) => typeof source.publishedAt === "string").length / sources.length,
    authoritySourceRate: sources.length === 0
      ? 0
      : sources.filter((source) => /(^|\.)((docs?|api|developer|github)\.)/iu.test(source.url)).length / sources.length,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

const cases = fixture.map((item) => {
  const providerLists = item.providers
    .filter((provider) => provider.status === "ok")
    .map((provider) => ({ provider: provider.provider, sources: provider.sources }));
  const rerankSources = item.rerank?.status === "ok" ? item.rerank.sources : [];
  const currentSources = providerLists.flatMap((list) => list.sources);
  const cleanedFast = cleanFastSources(item.query, currentSources, {
    mode: "on",
    maxResults: 5,
    domainCap: 2,
  });
  const challenger = providerAwareRrf(providerLists, rerankSources, { k: 60 });
  return {
    id: item.id,
    providerCount: providerLists.length,
    current: metrics(currentSources, item.labels ?? {}),
    cleanedFast: metrics(cleanedFast.sources, item.labels ?? {}),
    challenger: metrics(challenger, item.labels ?? {}),
    challengerTop5: challenger.slice(0, 5).map((source) => ({
      url: source.url,
      provider: source.provider,
      providerRanks: source.providerRanks,
      providerCoverage: source.providerCoverage,
      fusionScore: Number(source.fusionScore.toFixed(8)),
    })),
    providerLatencyMs: Object.fromEntries(item.providers.map((run) => [run.provider, run.elapsedMs])),
  };
});

const allProviderLatencies = fixture.flatMap((item) => item.providers.map((run) => run.elapsedMs));
const aggregate = Object.fromEntries(["current", "cleanedFast", "challenger"].map((method) => [
  method,
  {
    meanNdcg5: Number(average(cases.map((item) => item[method].ndcg5)).toFixed(4)),
    meanNdcg10: Number(average(cases.map((item) => item[method].ndcg10)).toFixed(4)),
    meanMrr: Number(average(cases.map((item) => item[method].mrr)).toFixed(4)),
    top1RelevantRate: Number(average(cases.map((item) => item[method].top1Relevant ? 1 : 0)).toFixed(4)),
  },
]));
const report = {
  schemaVersion: 1,
  baselineCommit: "a9c0f3b",
  productionDefaultChanged: false,
  datasetKind: "synthetic",
  k: 60,
  caseCount: cases.length,
  developmentCases: fixture.filter((item) => item.split === "development").length,
  heldOutCases: fixture.filter((item) => item.split === "held-out").length,
  latencyMs: {
    p50: percentile(allProviderLatencies, 0.5),
    p95: percentile(allProviderLatencies, 0.95),
  },
  aggregate,
  cases,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
