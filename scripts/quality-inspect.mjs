import { readFile } from "node:fs/promises";
import { cleanFastSources } from "../dist/quality.js";

const fixture = JSON.parse(
  await readFile(new URL("../work/quality/replay-fixture.json", import.meta.url), "utf8"),
);
const id = process.argv[2];
const item = fixture.find((entry) => entry.id === id);
if (item === undefined) throw new Error(`unknown case ${id}`);
const sources = item.providers.filter((p) => p.status === "ok").flatMap((p) => p.sources);
const cleaned = cleanFastSources(item.query, sources, { mode: "on", maxResults: 5, domainCap: 2 });
process.stdout.write(`${JSON.stringify({
  id,
  query: item.query,
  labels: item.labels,
  input: sources.map((s) => s.url),
  kept: cleaned.sources.map((s) => s.url),
  dropped: sources.filter((s) => !cleaned.sources.some((k) => k.url === s.url)).map((s) => s.url),
  selectedCount: cleaned.selectedCount,
  candidateCount: cleaned.candidateCount,
}, null, 2)}\n`);
