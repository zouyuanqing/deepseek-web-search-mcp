import { describe, expect, it } from "vitest";
import { canonicalizeUrl, dedupeSources, resolveScope } from "../src/utils.js";

describe("scope resolution", () => {
  it("selects Chinese scope for Han text", () => {
    expect(resolveScope("上海今天天气", "auto")).toBe("cn");
  });

  it("selects global scope for English text", () => {
    expect(resolveScope("Shanghai weather", "auto")).toBe("global");
  });

  it("honors an explicit scope", () => {
    expect(resolveScope("上海今天天气", "global")).toBe("global");
  });
});

describe("URL normalization", () => {
  it("removes fragments and tracking parameters", () => {
    expect(canonicalizeUrl("https://Example.com/a?utm_source=x&b=2#section")).toBe(
      "https://example.com/a?b=2",
    );
  });

  it("deduplicates canonical URLs", () => {
    const sources = dedupeSources([
      { url: "https://example.com/a?utm_source=x", provider: "tavily" },
      { url: "https://example.com/a", provider: "searxng" },
    ]);
    expect(sources).toHaveLength(1);
  });
});
