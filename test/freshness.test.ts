import { describe, expect, it } from "vitest";
import { applyFreshnessPolicy, combineFreshnessReports } from "../src/freshness.js";
import type { SearchSource } from "../src/types.js";

const now = new Date("2026-09-25T00:00:00.000Z");

function source(url: string, publishedAt?: string): SearchSource {
  return {
    url,
    provider: "tavily",
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

describe("freshness policy", () => {
  it("keeps soft results but marks undated provider output as unknown", () => {
    const result = applyFreshnessPolicy(
      "anysearch",
      [source("https://example.com/a")],
      "day",
      "soft",
      now,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.report.status).toBe("unknown");
    expect(result.report.providerCapabilities.anysearch).toBe("soft");
  });

  it("strictly removes undated and stale results", () => {
    const result = applyFreshnessPolicy(
      "tavily",
      [
        source("https://example.com/new", "2026-09-24T12:00:00.000Z"),
        source("https://example.com/old", "2026-09-01T00:00:00.000Z"),
        source("https://example.com/unknown"),
      ],
      "week",
      "strict",
      now,
    );

    expect(result.sources.map((item) => item.url)).toEqual(["https://example.com/new"]);
    expect(result.report.status).toBe("estimated");
    expect(result.report.filteredCount).toBe(2);
  });

  it("marks an entirely unmet strict request", () => {
    const result = applyFreshnessPolicy(
      "tavily",
      [source("https://example.com/old", "2026-01-01T00:00:00.000Z")],
      "day",
      "strict",
      now,
    );

    expect(result.sources).toHaveLength(0);
    expect(result.report.status).toBe("unmet");
  });

  it("combines provider statuses without losing capability metadata", () => {
    const report = combineFreshnessReports([
      applyFreshnessPolicy("tavily", [source("https://a", "2026-09-24")], "day", "soft", now).report,
      applyFreshnessPolicy("anysearch", [source("https://b")], "day", "soft", now).report,
    ], "day", "soft");

    expect(report.status).toBe("unknown");
    expect(report.providerCapabilities).toEqual({ tavily: "native", anysearch: "soft" });
  });
});
