import { readFile } from "node:fs/promises";

const report = JSON.parse(
  await readFile(new URL("../work/quality/baseline-report.json", import.meta.url), "utf8"),
);

const rows = Object.entries(report.aggregate).map(([method, value]) => ({
  method,
  meanNdcg5: value.meanNdcg5,
  top1RelevantRate: value.top1RelevantRate,
  officialInTop1Rate: value.officialInTop1Rate,
  meanOfficialSourcesTop5: value.meanOfficialSourcesTop5,
  duplicateSlotsTop5Rate: value.duplicateSlotsTop5Rate,
  lowAuthorityShareTop5: value.lowAuthorityShareTop5,
  meanDistinctOrigins: value.meanDistinctOrigins,
}));

process.stdout.write(`${JSON.stringify({
  caseCount: report.caseCount,
  developmentCases: report.developmentCases,
  heldOutCases: report.heldOutCases,
  datasetKind: report.datasetKind,
  productionDefaultChanged: report.productionDefaultChanged,
  freshnessIntentCases: report.freshnessIntentCases,
  identityTotals: report.identityTotals,
  byCategory: report.byCategory,
  latencyMs: report.latencyMs,
  rows,
}, null, 2)}\n`);
