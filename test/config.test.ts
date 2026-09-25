import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("web search backend configuration", () => {
  it("uses auto by default so a configured native key can join the source pool", () => {
    expect(loadConfig({}).webSearchBackend).toBe("auto");
    expect(loadConfig({}).fastCleaningMode).toBe("shadow");
    expect(loadConfig({}).fastDomainCap).toBe(2);
    expect(loadConfig({}).researchSessionTtlMs).toBe(1_800_000);
    expect(loadConfig({}).researchSessionMaxTurns).toBe(8);
  });

  it("accepts native, hybrid, and automatic backend defaults", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "external" }).webSearchBackend).toBe("external");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "deepseek-native" }).webSearchBackend)
      .toBe("deepseek-native");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "hybrid" }).webSearchBackend).toBe("hybrid");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "auto" }).webSearchBackend).toBe("auto");
  });

  it("falls back to auto for an unknown backend value", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "unknown" }).webSearchBackend).toBe("auto");
  });

  it("accepts explicit fast-cleaning configuration", () => {
    expect(loadConfig({ FAST_CLEANING_MODE: "on" }).fastCleaningMode).toBe("on");
    expect(loadConfig({ FAST_DOMAIN_CAP: "3" }).fastDomainCap).toBe(3);
  });
});
