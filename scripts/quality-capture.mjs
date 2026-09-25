import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../dist/config.js";
import { DeepSeekNativeSearchProvider } from "../dist/providers/deepseek-native.js";
import { buildProviderRegistry, hybridProviderOrder } from "../dist/service.js";
import { OpenRouterReranker } from "../dist/providers/openrouter-rerank.js";
import { dedupeSources, resolveScope } from "../dist/utils.js";

const query = (process.argv[2] ?? "DeepSeek official API documentation").replaceAll("^", "");
const scope = resolveScope(query, "auto");
const config = loadConfig(process.env);
const providers = buildProviderRegistry(config);
const native = new DeepSeekNativeSearchProvider(config);
const order = hybridProviderOrder(scope);
const startedAll = performance.now();

async function captureProvider(provider) {
  const started = performance.now();
  try {
    if (provider === "deepseek-native") {
      const result = await native.research({
        query,
        maxSources: 10,
        freshness: "any",
      });
      return {
        provider,
        status: result.sources.length > 0 ? "ok" : "empty",
        elapsedMs: Math.round(performance.now() - started),
        sources: result.sources,
        nativeSearchRequests: result.nativeSearchRequests,
        nativeSearchCalls: result.nativeSearchCalls,
        warnings: result.warnings,
      };
    }
    const result = await providers[provider].search({
      query,
      scope: "auto",
      maxResults: 10,
      freshness: "any",
      quality: "fast",
      rerank: false,
    });
    return {
      provider,
      status: result.sources.length > 0 ? "ok" : "empty",
      elapsedMs: Math.round(performance.now() - started),
      sources: result.sources,
      warnings: result.warnings,
    };
  } catch (error) {
    return {
      provider,
      status: "error",
      elapsedMs: Math.round(performance.now() - started),
      sources: [],
      errorCode: error?.code ?? "unknown",
      errorMessage: error?.message ?? String(error),
    };
  }
}

const providerRuns = await Promise.all(order.map(captureProvider));
const candidateSources = dedupeSources(providerRuns.flatMap((run) => run.sources));
const reranker = new OpenRouterReranker(config);
const rerankStarted = performance.now();
let rerank;
try {
  const result = await reranker.rerank(query, candidateSources.slice(0, 30));
  rerank = {
    status: "ok",
    model: result.model,
    elapsedMs: result.elapsedMs,
    sources: result.sources,
  };
} catch (error) {
  rerank = {
    status: "error",
    model: config.openRouterRerankModel,
    elapsedMs: Math.round(performance.now() - rerankStarted),
    sources: [],
    errorCode: error?.code ?? "unknown",
    errorMessage: error?.message ?? String(error),
  };
}

const output = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  query,
  scope,
  freshness: "any",
  providers: providerRuns,
  rerank,
  totalElapsedMs: Math.round(performance.now() - startedAll),
};
const outputDir = new URL("../work/quality/runtime/", import.meta.url);
await mkdir(outputDir, { recursive: true });
await writeFile(new URL("latest.json", outputDir), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output: "work/quality/runtime/latest.json",
  query,
  providers: providerRuns.map((run) => ({ provider: run.provider, status: run.status, sources: run.sources.length })),
  rerank: { status: rerank.status, sources: rerank.sources.length },
  totalElapsedMs: output.totalElapsedMs,
}, null, 2)}\n`);
