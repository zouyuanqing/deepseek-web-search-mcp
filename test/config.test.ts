import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("web search backend configuration", () => {
  it("keeps external search as the backward-compatible default", () => {
    expect(loadConfig({}).webSearchBackend).toBe("external");
  });

  it("accepts native and automatic backend defaults", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "deepseek-native" }).webSearchBackend)
      .toBe("deepseek-native");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "auto" }).webSearchBackend).toBe("auto");
  });

  it("falls back to external for an unknown backend value", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "unknown" }).webSearchBackend).toBe("external");
  });
});
