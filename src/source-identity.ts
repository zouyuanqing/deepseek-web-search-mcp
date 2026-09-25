import { domainKey, hostKey, isLowAuthorityHost } from "./hosts.js";
import type { SearchSource } from "./types.js";
import { canonicalizeUrl, normalizeWhitespace } from "./utils.js";

const LANGUAGE_SEGMENTS: readonly string[] = [
  "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de",
  "el", "en", "eo", "es", "et", "eu", "fa", "fi", "fil", "fr", "ga", "gl", "gu",
  "he", "hi", "hr", "hu", "hy", "id", "is", "it", "ja", "ka", "kk", "km", "kn",
  "ko", "ky", "lo", "lt", "lv", "mk", "ml", "mn", "mr", "ms", "my", "ne", "nl",
  "no", "pa", "pl", "ps", "pt", "ro", "ru", "si", "sk", "sl", "sq", "sr", "sv",
  "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "uz", "vi", "zh",
  "zh-cn", "zh-hans", "zh-hant", "zh-tw", "en-us", "en-gb", "pt-br", "es-mx",
  "fr-ca", "zh-hk",
];

const LANGUAGE_SEGMENT_SET = new Set(LANGUAGE_SEGMENTS);
const AMPL_SUFFIX = /\/(?:amp|amp\.html)$/iu;
const INDEX_SUFFIX = /\/(?:index|default)\.(?:html?|php|aspx?)$/iu;

const TITLE_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "how", "in", "into", "is", "it", "its", "more", "most", "not",
  "of", "on", "or", "our", "so", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "was", "we", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your",
]);

export interface ParsedSourceUrl {
  canonical: string;
  host: string;
  domain: string;
  pathKey: string;
  language?: string;
  slug: string;
}

export interface SourceIdentity {
  key: string;
  slug: string;
  language?: string;
}

export type DuplicateReason = "same-url" | "language-variant" | "syndicated-copy";

export interface SourceIdentityGroup {
  key: string;
  keptUrl: string;
  mergedUrls: string[];
  hosts: string[];
  languageVariants: string[];
  reason: DuplicateReason;
  dateConflict: boolean;
}

export interface SourceIdentityResult {
  sources: SearchSource[];
  mergedCount: number;
  languageVariantCount: number;
  crossHostCopyCount: number;
  conflictingDateCount: number;
  groups: SourceIdentityGroup[];
}

export interface SourceIndependence {
  totalSources: number;
  independentDomains: number;
  dominantDomain?: string;
  dominantDomainShare: number;
  lowAuthoritySources: number;
  lowAuthorityShare: number;
  duplicateSources: number;
  independence: "high" | "medium" | "low";
  notes: string[];
}

function stripLanguageSegment(pathname: string): { path: string; language?: string } {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return { path: pathname };
  const head = segments[0]!.toLowerCase();
  if (!LANGUAGE_SEGMENT_SET.has(head)) return { path: pathname };
  const rest = segments.slice(1).join("/");
  return { path: `/${rest}`, language: head };
}

function normalizePath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/gu, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  path = path.replace(AMPL_SUFFIX, "").replace(INDEX_SUFFIX, "");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return (path.length === 0 ? "/" : path).toLowerCase();
}

export function parseSourceUrl(raw: string): ParsedSourceUrl | null {
  const canonical = canonicalizeUrl(raw);
  if (canonical === null) return null;
  const url = new URL(canonical);
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized === "lang" || normalized === "locale" || normalized === "hl") {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  const cleaned = url.toString();
  const stripped = stripLanguageSegment(url.pathname);
  const pathKey = normalizePath(stripped.path);
  return {
    canonical: cleaned,
    host: hostKey(cleaned),
    domain: domainKey(cleaned),
    pathKey,
    ...(stripped.language === undefined ? {} : { language: stripped.language }),
    slug: pathKey.split("/").filter(Boolean).slice(-1)[0] ?? "",
  };
}

function titleTokens(title: string | undefined): string[] {
  const normalized = normalizeWhitespace((title ?? "").normalize("NFKC").toLowerCase());
  return normalized.replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token));
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function titleSimilarity(left: SearchSource, right: SearchSource): number {
  return jaccard(new Set(titleTokens(left.title)), new Set(titleTokens(right.title)));
}

function snippetSimilarity(left: SearchSource, right: SearchSource): number {
  const leftText = normalizeWhitespace((left.snippet ?? "").toLowerCase());
  const rightText = normalizeWhitespace((right.snippet ?? "").toLowerCase());
  if (leftText.length < 80 || rightText.length < 80) return 0;
  if (leftText === rightText) return 1;
  return jaccard(new Set(leftText.split(" ")), new Set(rightText.split(" ")));
}

function publishedTimestamp(source: SearchSource): number | undefined {
  if (source.publishedAt === undefined) return undefined;
  const value = Date.parse(source.publishedAt);
  return Number.isFinite(value) ? value : undefined;
}

function isSameArticleDate(left: SearchSource, right: SearchSource): boolean {
  const leftTime = publishedTimestamp(left);
  const rightTime = publishedTimestamp(right);
  if (leftTime === undefined || rightTime === undefined) return true;
  return Math.abs(leftTime - rightTime) <= 24 * 60 * 60 * 1000;
}

function mergeMetadata(kept: SearchSource, merged: SearchSource): SearchSource {
  const result: SearchSource = { ...kept };
  if (result.title === undefined && merged.title !== undefined) result.title = merged.title;
  if (result.snippet === undefined && merged.snippet !== undefined) result.snippet = merged.snippet;
  if (result.publishedAt === undefined && merged.publishedAt !== undefined) result.publishedAt = merged.publishedAt;
  if (result.score === undefined && merged.score !== undefined) result.score = merged.score;
  return result;
}

export function sourceIdentity(raw: string): SourceIdentity | null {
  const parsed = parseSourceUrl(raw);
  if (parsed === null) return null;
  return {
    key: `${parsed.host}${parsed.pathKey}`,
    slug: parsed.slug,
    ...(parsed.language === undefined ? {} : { language: parsed.language }),
  };
}

interface ClusterEntry {
  source: SearchSource;
  index: number;
  reason: DuplicateReason;
  language?: string;
}

interface Cluster {
  key: string;
  slug: string;
  domain: string;
  entries: ClusterEntry[];
}

export interface SourceIdentityOptions {
  crossHostThreshold?: number;
  crossHost?: boolean;
}

export function dedupeSourceIdentities(
  sources: SearchSource[],
  options: SourceIdentityOptions = {},
): SourceIdentityResult {
  const crossHost = options.crossHost ?? true;
  const crossHostThreshold = options.crossHostThreshold ?? 0.6;
  const clusters: Cluster[] = [];
  const seenCanonical = new Set<string>();

  for (const [index, source] of sources.entries()) {
    const parsed = parseSourceUrl(source.url);
    if (parsed === null) continue;
    if (seenCanonical.has(parsed.canonical)) continue;
    seenCanonical.add(parsed.canonical);
    const key = `${parsed.host}${parsed.pathKey}`;
    const entry: ClusterEntry = {
      source,
      index,
      reason: "same-url",
      ...(parsed.language === undefined ? {} : { language: parsed.language }),
    };
    const sameKey = clusters.find((cluster) => cluster.key === key);
    if (sameKey !== undefined) {
      sameKey.entries.push({
        ...entry,
        reason: sameKey.entries[0]?.language === entry.language ? "same-url" : "language-variant",
      });
      continue;
    }
    let syndicated: Cluster | undefined;
    if (crossHost && parsed.slug.length >= 8) {
      syndicated = clusters.find((cluster) =>
        cluster.domain !== parsed.domain
        && cluster.slug === parsed.slug
 && (titleSimilarity(cluster.entries[0]!.source, source) >= crossHostThreshold
          || snippetSimilarity(cluster.entries[0]!.source, source) >= 0.85));
    }
    if (syndicated !== undefined) {
      syndicated.entries.push({ ...entry, reason: "syndicated-copy" });
      continue;
    }
    clusters.push({ key, slug: parsed.slug, domain: parsed.domain, entries: [entry] });
  }

  const groups: SourceIdentityGroup[] = [];
  const order: Array<{ position: number; source: SearchSource }> = [];
  let mergedCount = 0;
  let languageVariantCount = 0;
  let crossHostCopyCount = 0;
  let conflictingDateCount = 0;
  for (const cluster of clusters) {
    const ordered = [...cluster.entries].sort((left, right) => {
      const authority = Number(isLowAuthorityHost(left.source.url)) - Number(isLowAuthorityHost(right.source.url));
      if (authority !== 0) return authority;
      const dated = Number(publishedTimestamp(left.source) !== undefined) - Number(publishedTimestamp(right.source) !== undefined);
      if (dated !== 0) return -dated;
      return left.index - right.index;
    });
    const keptEntry = ordered[0]!;
    let kept = keptEntry.source;
    let dateConflictFound = false;
    for (const entry of ordered.slice(1)) {
      if (!isSameArticleDate(kept, entry.source)) dateConflictFound = true;
      kept = mergeMetadata(kept, entry.source);
    }
    mergedCount += ordered.length - 1;
    languageVariantCount += ordered.filter((entry) => entry.reason === "language-variant").length;
    crossHostCopyCount += ordered.filter((entry) => entry.reason === "syndicated-copy").length;
    if (dateConflictFound) conflictingDateCount += 1;
    if (ordered.length > 1) {
      groups.push({
        key: cluster.key,
        keptUrl: kept.url,
        mergedUrls: ordered.slice(1).map((entry) => parseSourceUrl(entry.source.url)?.canonical ?? entry.source.url),
        hosts: [...new Set(ordered.map((entry) => hostKey(entry.source.url)))],
        languageVariants: [...new Set(ordered.map((entry) => entry.language).filter((value): value is string => value !== undefined))],
        reason: ordered.some((entry) => entry.reason === "syndicated-copy") ? "syndicated-copy" : ordered.some((entry) => entry.reason === "language-variant") ? "language-variant" : "same-url",
        dateConflict: dateConflictFound,
      });
    }
    order.push({ position: Math.min(...ordered.map((entry) => entry.index)), source: { ...kept } });
  }
  order.sort((left, right) => left.position - right.position);
  return {
    sources: order.map((item) => item.source),
    mergedCount,
    languageVariantCount,
    crossHostCopyCount,
    conflictingDateCount,
    groups,
  };
}

export function analyzeSourceIndependence(
  sources: SearchSource[],
  identity: Pick<SourceIdentityResult, "mergedCount" | "crossHostCopyCount">,
): SourceIndependence {
  const total = sources.length;
  if (total === 0) {
    return {
      totalSources: 0,
      independentDomains: 0,
      dominantDomainShare: 0,
      lowAuthoritySources: 0,
      lowAuthorityShare: 0,
      duplicateSources: identity.mergedCount,
      independence: "low",
      notes: [],
    };
  }
  const perDomain = new Map<string, number>();
  let lowAuthority = 0;
  for (const source of sources) {
    const domain = domainKey(source.url);
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    if (isLowAuthorityHost(source.url)) lowAuthority += 1;
  }
  const ranked = [...perDomain.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const dominant = ranked[0];
  const dominantDomainShare = dominant === undefined ? 0 : dominant[1] / total;
  const lowAuthorityShare = lowAuthority / total;
  const independentDomains = perDomain.size;
  const notes: string[] = [];

  if (identity.crossHostCopyCount > 0) {
    notes.push(`${identity.crossHostCopyCount} source(s) were syndicated copies of another source; agreement between them is not independent corroboration.`);
  }
  if (dominantDomainShare >= 0.5 && independentDomains <= 2) {
    notes.push(`Most sources come from ${dominant?.[0] ?? "one domain"}; treat this as a single-origin answer.`);
  }
  if (lowAuthorityShare >= 0.5) {
    notes.push(`${Math.round(lowAuthorityShare * 100)}% of sources are aggregators or content farms; confirm key numbers against a primary source.`);
  }

  let independence: SourceIndependence["independence"] = "high";
  const duplicateShare = identity.mergedCount / total;
  if (independentDomains <= 1 || lowAuthorityShare >= 0.5 || duplicateShare >= 0.4) {
    independence = "low";
  } else if (independentDomains <= 2 || lowAuthorityShare > 0 || identity.mergedCount > 0) {
    independence = "medium";
  }

  return {
    totalSources: total,
    independentDomains,
    ...(dominant === undefined ? {} : { dominantDomain: dominant[0] }),
    dominantDomainShare: Number(dominantDomainShare.toFixed(4)),
    lowAuthoritySources: lowAuthority,
    lowAuthorityShare: Number(lowAuthorityShare.toFixed(4)),
    duplicateSources: identity.mergedCount,
    independence,
    notes,
  };
}
