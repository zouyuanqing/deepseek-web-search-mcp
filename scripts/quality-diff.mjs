import { readFile } from "node:fs/promises";

const report = JSON.parse(
  await readFile(new URL("../work/quality/baseline-report.json", import.meta.url), "utf8"),
);

const rows = report.cases
  .filter((item) => item.category !== "syndication" && item.category !== "aggregator-dominance")
  .map((item) => ({
    id: item.id,
    delta: Number((item.productionFast.ndcg5 - item.current.ndcg5).toFixed(4)),
    current: item.current.ndcg5,
    productionFast: item.productionFast.ndcg5,
  }))
  .filter((row) => row.delta !== 0);

process.stdout.write(`${JSON.stringify({ regressedCases: rows.length, rows: rows.slice(0, 6) }, null, 2)}\n`);
