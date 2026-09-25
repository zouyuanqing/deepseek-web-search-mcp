export type HostClass = "primary" | "reference" | "aggregator" | "content-farm" | "unknown";

/**
 * User-generated or social platforms. They are frequently useful for sentiment
 * but must never receive an authority prior.
 */
export const AGGREGATOR_HOSTS: readonly string[] = [
  "reddit.com",
  "medium.com",
  "youtube.com",
  "youtu.be",
  "sohu.com",
  "zhihu.com",
  "csdn.net",
  "juejin.cn",
  "cnblogs.com",
  "segmentfault.com",
  "toutiao.com",
  "dev.to",
  "quora.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "linkedin.com",
  "bilibili.com",
  "douban.com",
  "tieba.baidu.com",
];

/**
 * SEO/AI content farms and aggregator mirrors. Reported repeatedly in real
 * research answers, especially for the same article republished in many
 * languages. Never give them an authority prior.
 */
export const CONTENT_FARM_HOSTS: readonly string[] = [
  "ofox.ai",
  "techsy.io",
  "taskade.com",
  "aitoolly.com",
  "aiforpdf.com",
  "pdf.ai",
  "docshero.com",
  "sitejabber.com",
  "productbard.com",
  "techstackexplorer.com",
  "gadgetmart.com",
  "itoolszone.com",
  "thequantumgadget.com",
  "quantumaitool.com",
  "aitoolmall.com",
  "genuineai.com",
  "aitoolplanet.com",
];

/**
 * Official engineering/reference infrastructure that is authoritative for the
 * artifact itself but not for third-party claims.
 */
export const REFERENCE_HOSTS: readonly string[] = [
  "arxiv.org",
  "doi.org",
  "wikipedia.org",
  "wikidata.org",
  "nist.gov",
  "ietf.org",
  "w3.org",
  "ieee.org",
  "acm.org",
  "springer.com",
  "sciencedirect.com",
  "nature.com",
  "science.org",
];

const MULTI_LEVEL_PUBLIC_SUFFIXES: readonly string[] = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.cn",
  "org.cn",
  "net.cn",
  "gov.cn",
  "edu.cn",
  "ac.cn",
  "co.jp",
  "or.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "com.au",
  "com.br",
  "com.mx",
  "com.tr",
  "com.tw",
  "com.sg",
  "com.hk",
  "co.in",
  "co.za",
];

export function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return url.toLowerCase();
  }
}

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./u, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LEVEL_PUBLIC_SUFFIXES.includes(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

export function domainKey(url: string): string {
  return registrableDomain(hostKey(url));
}

function matchesHostList(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function isAggregatorHost(host: string): boolean {
  return matchesHostList(host, AGGREGATOR_HOSTS);
}

export function isContentFarmHost(host: string): boolean {
  return matchesHostList(host, CONTENT_FARM_HOSTS);
}

export function isReferenceHost(host: string): boolean {
  return matchesHostList(host, REFERENCE_HOSTS);
}

export function isDocumentationHostOrPath(host: string, pathname: string): boolean {
  return /^(?:docs|developers|api|api-docs|developer)\./u.test(host)
    || /\/(?:docs?|reference|api|manual)(?:\/|$)/iu.test(pathname);
}

export function isPublicAuthorityHost(host: string): boolean {
  return host.split(".").some((label) => label === "gov" || label === "edu");
}

/**
 * Classifies a host without looking at the query. Query-aware authority is
 * still computed in ranking.ts; this is the neutral, query-independent tier.
 */
export function hostClass(url: string): HostClass {
  const host = hostKey(url);
  if (isAggregatorHost(host)) return "aggregator";
  if (isContentFarmHost(host)) return "content-farm";
  if (isReferenceHost(host)) return "reference";
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = "";
  }
  if (isDocumentationHostOrPath(host, pathname) || isPublicAuthorityHost(host)) {
    return "primary";
  }
  return "unknown";
}

/**
 * Non-authoritative hosts only. Used where a neutral default would otherwise
 * silently reward an unknown domain (the subagent finding: unknown domains
 * must stay neutral, so this returns false for them).
 */
export function isLowAuthorityHost(url: string): boolean {
  const host = hostKey(url);
  return isAggregatorHost(host) || isContentFarmHost(host);
}
