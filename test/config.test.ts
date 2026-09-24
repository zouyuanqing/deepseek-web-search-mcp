import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("web search backend configuration", () => {
  it("uses auto by default so a configured native key can join the source pool", () => {
    expect(loadConfig({}).webSearchBackend).toBe("auto");
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
});
