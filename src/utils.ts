import { errorText } from "./errors.js";
import type { Freshness, ResolvedScope, Scope, SearchSource } from "./types.js";

export class OperationTimeoutError extends Error {
  override readonly name = "TimeoutError";
}

export function hasHanCharacters(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

export function resolveScope(query: string, scope: Scope): ResolvedScope {
  if (scope !== "auto") return scope;
  return hasHanCharacters(query) ? "cn" : "global";
}

export function freshnessLabel(freshness: Freshness): string {
  switch (freshness) {
    case "day":
      return "past day";
    case "week":
      return "past week";
    case "month":
      return "past month";
    case "year":
      return "past year";
    default:
      return "";
  }
}

export function applyFreshnessToQuery(query: string, freshness: Freshness): string {
  const label = freshnessLabel(freshness);
  return label.length === 0 ? query : `${query} ${label}`;
}

export function canonicalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    const removable = [...url.searchParams.keys()].filter((key) => {
      const normalized = key.toLowerCase();
      return normalized.startsWith("utm_") || normalized === "fbclid" || normalized === "gclid";
    });
    for (const key of removable) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function dedupeSources(sources: SearchSource[]): SearchSource[] {
  const seen = new Set<string>();
  const output: SearchSource[] = [];
  for (const source of sources) {
    const canonical = canonicalizeUrl(source.url);
    if (canonical === null || seen.has(canonical)) continue;
    seen.add(canonical);
    output.push({ ...source, url: canonical });
  }
  return output;
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new OperationTimeoutError(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted === true) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return JSON.stringify({ serializationError: errorText(error) }, null, 2);
  }
}
