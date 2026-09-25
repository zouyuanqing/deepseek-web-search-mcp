import { describe, expect, it } from "vitest";
import {
  detectFreshnessIntent,
  freshnessIntentWarning,
} from "../src/freshness-intent.js";

describe("time-sensitivity detection", () => {
  it("detects fast-changing model and version questions", () => {
    const queries = [
      "DeepSeek latest model version",
      "what is the current OpenAI pricing",
      "DeepSeek 最新模型版本",
      "SearXNG changelog",
    ];
    for (const query of queries) {
      const intent = detectFreshnessIntent(query);
      expect(intent.timeSensitive, query).toBe(true);
      expect(intent.recommendedMode, query).toBe("strict");
      expect(intent.recommendedFreshness, query).toBe("month");
    }
  });

  it("detects day-level live facts", () => {
    const intent = detectFreshnessIntent("上海今天的天气");
    expect(intent.timeSensitive).toBe(true);
    expect(intent.recommendedFreshness).toBe("day");
  });

  it("picks the tightest window when several signals match", () => {
    const intent = detectFreshnessIntent("latest release notes for this week");
    expect(intent.recommendedFreshness).toBe("week");
    expect(intent.signals.length).toBeGreaterThan(1);
  });

  it("treats stable reference questions as not time-sensitive", () => {
    const queries = [
      "how does the RRF rank fusion algorithm work",
      "SearXNG Docker installation guide",
      "Python asyncio tutorial",
    ];
    for (const query of queries) {
      expect(detectFreshnessIntent(query).timeSensitive, query).toBe(false);
    }
  });
});

describe("strict-mode recommendation", () => {
  it("recommends a window and strict mode when freshness was left as any", () => {
    const warning = freshnessIntentWarning("DeepSeek latest model", "any", undefined);
    expect(warning).toMatch(/time-sensitive/u);
    expect(warning).toMatch(/freshness="month", freshness_mode="strict"/u);
  });

  it("only recommends strict mode when a window was already requested", () => {
    const warning = freshnessIntentWarning("DeepSeek latest model", "week", "soft");
    expect(warning).toMatch(/freshness_mode="strict"/u);
    expect(warning).not.toMatch(/freshness="/u);
  });

  it("stays silent once the caller already asked for strict with a window", () => {
    expect(freshnessIntentWarning("DeepSeek latest model", "month", "strict")).toBeUndefined();
  });

  it("stays silent for queries with no time signal", () => {
    expect(freshnessIntentWarning("how RRF works", "any", "soft")).toBeUndefined();
  });
});
