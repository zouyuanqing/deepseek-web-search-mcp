import { readFile, writeFile } from "node:fs/promises";
import { cleanFastSources, providerAwareRrf } from "../dist/quality.js";
import { analyzeSourceIndependence, dedupeSourceIdentities } from "../dist/source-identity.js";
import { detectFreshnessIntent } from "../dist/freshness-intent.js";
import { authorityScore } from "../dist/ranking.js";

const LOW_AUTHORITY = /(^|\.)((www\.)?(reddit|medium|youtube|youtu|sohu|zhihu|csdn|juejin|cnblogs|segmentfault|toutiao|dev|quora|x|twitter|facebook|linkedin|bilibili|douban)\.|ofox\.ai|techsy\.io|taskade\.com)/iu;

function isLowAuthorityUrl(url) {
  try {
    return LOW_AUTHORITY.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

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

function metrics(sources, labels, query) {
  const ndcg5 = idealDcg(labels, 5) === 0 ? 0 : dcg(sources, labels, 5) / idealDcg(labels, 5);
  const ndcg10 = idealDcg(labels, 10) === 0 ? 0 : dcg(sources, labels, 10) / idealDcg(labels, 10);
  const firstRelevant = sources.findIndex((source) => (labels[source.url] ?? 0) > 0);
  const top5 = sources.slice(0, 5);
  const top5Identity = dedupeSourceIdentities(top5);
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
    distinctOrigins: new Set(sources.map((source) => {
      try {
        const host = new URL(source.url).hostname.replace(/^www\./u, "");
        const parts = host.split(".");
        return parts.slice(-2).join(".");
      } catch {
        return source.url;
      }
    })).size,
    // Redundant-slot rate: how many of the visible top-5 slots are copies of a
    // source the user already has. This, not nDCG, is the metric that captures
    // the "same article listed in three languages" complaint.
    duplicateSlotsTop5: top5.length === 0 ? 0 : top5Identity.mergedCount / top5.length,
    lowAuthorityShareTop5: top5.length === 0
      ? 0
      : top5.filter((source) => isLowAuthorityUrl(source.url)).length / top5.length,
    // Uses the same authorityScore the production ranker uses, so this metric
    // cannot silently disagree with what the service actually computes.
    officialSourcesTop5: top5.filter((source) => authorityScore(query, source) >= 0.7).length,
    officialInTop1: top5.length > 0 && authorityScore(query, top5[0]) >= 0.7,
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
  const identity = dedupeSourceIdentities(currentSources);
  const independence = analyzeSourceIndependence(identity.sources, identity);
  // What production actually returns for quality=fast with cleaning enabled:
  // merge -> exact dedupe -> authority cleaning -> identity collapse.
  const productionFast = dedupeSourceIdentities(cleanedFast.sources, { crossHost: true });
  return {
    id: item.id,
    category: item.category ?? item.id.split("-")[0],
    split: item.split,
    providerCount: providerLists.length,
    current: metrics(currentSources, item.labels ?? {}, item.query),
    cleanedFast: metrics(cleanedFast.sources, item.labels ?? {}, item.query),
    challenger: metrics(challenger, item.labels ?? {}, item.query),
    identityDedup: metrics(identity.sources, item.labels ?? {}, item.query),
    productionFast: metrics(productionFast.sources, item.labels ?? {}, item.query),
    identityStats: {
      inputCount: currentSources.length,
      outputCount: identity.sources.length,
      mergedCount: identity.mergedCount,
      languageVariantCount: identity.languageVariantCount,
      crossHostCopyCount: identity.crossHostCopyCount,
      conflictingDateCount: identity.conflictingDateCount,
      independence: independence.independence,
      lowAuthorityShare: independence.lowAuthorityShare,
    },
    freshnessIntent: detectFreshnessIntent(item.query),
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
const METHODS = ["current", "cleanedFast", "challenger", "identityDedup", "productionFast"];
const aggregate = Object.fromEntries(METHODS.map((method) => [
  method,
  {
    meanNdcg5: Number(average(cases.map((item) => item[method].ndcg5)).toFixed(4)),
    meanNdcg10: Number(average(cases.map((item) => item[method].ndcg10)).toFixed(4)),
    meanMrr: Number(average(cases.map((item) => item[method].mrr)).toFixed(4)),
    top1RelevantRate: Number(average(cases.map((item) => item[method].top1Relevant ? 1 : 0)).toFixed(4)),
    meanDistinctOrigins: Number(average(cases.map((item) => item[method].distinctOrigins)).toFixed(4)),
    duplicateSlotsTop5Rate: Number(average(cases.map((item) => item[method].duplicateSlotsTop5)).toFixed(4)),
    lowAuthorityShareTop5: Number(average(cases.map((item) => item[method].lowAuthorityShareTop5)).toFixed(4)),
    meanOfficialSourcesTop5: Number(average(cases.map((item) => item[method].officialSourcesTop5)).toFixed(4)),
    officialInTop1Rate: Number(average(cases.map((item) => item[method].officialInTop1 ? 1 : 0)).toFixed(4)),
  },
]));
const identityTotals = cases.reduce(
  (totals, item) => ({
    mergedCount: totals.mergedCount + item.identityStats.mergedCount,
    languageVariantCount: totals.languageVariantCount + item.identityStats.languageVariantCount,
    crossHostCopyCount: totals.crossHostCopyCount + item.identityStats.crossHostCopyCount,
    conflictingDateCount: totals.conflictingDateCount + item.identityStats.conflictingDateCount,
  }),
  { mergedCount: 0, languageVariantCount: 0, crossHostCopyCount: 0, conflictingDateCount: 0 },
);
const byCategory = {};
for (const item of cases) {
  const bucket = byCategory[item.category] ?? (byCategory[item.category] = {
    cases: 0,
    mergedCount: 0,
    current: { ndcg5: 0, officialInTop1: 0, lowAuthorityShareTop5: 0 },
    productionFast: { ndcg5: 0, officialInTop1: 0, lowAuthorityShareTop5: 0 },
  });
  bucket.cases += 1;
  bucket.mergedCount += item.identityStats.mergedCount;
  for (const method of ["current", "productionFast"]) {
    bucket[method].ndcg5 += item[method].ndcg5;
    bucket[method].officialInTop1 += item[method].officialInTop1 ? 1 : 0;
    bucket[method].lowAuthorityShareTop5 += item[method].lowAuthorityShareTop5;
  }
}
for (const bucket of Object.values(byCategory)) {
  for (const method of ["current", "productionFast"]) {
    bucket[method].ndcg5 = Number((bucket[method].ndcg5 / bucket.cases).toFixed(4));
    bucket[method].officialInTop1 = Number((bucket[method].officialInTop1 / bucket.cases).toFixed(4));
    bucket[method].lowAuthorityShareTop5 = Number((bucket[method].lowAuthorityShareTop5 / bucket.cases).toFixed(4));
  }
}
const report = {
  schemaVersion: 1,
  baselineCommit: "a3d8a41",
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
  identityTotals,
  byCategory,
  freshnessIntentCases: cases.filter((item) => item.freshnessIntent.timeSensitive).length,
  aggregate,
  cases,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
