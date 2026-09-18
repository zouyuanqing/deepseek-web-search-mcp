import { describe, expect, it } from "vitest";
import { parseAnySearchMarkdown } from "../src/providers/anysearch.js";

describe("AnySearch markdown parser", () => {
  it("extracts normalized sources and snippets", () => {
    const sources = parseAnySearchMarkdown(`
## Search Results (2 results, 100ms)

### 1. Shanghai Weather
- **URL**: https://weather.example.com/shanghai?utm_source=test
Current weather and forecast.

### 2. CMA
- **URL**: http://weather.cma.cn/web/weather/58367.html
Official city forecast.
`);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      title: "Shanghai Weather",
      url: "https://weather.example.com/shanghai",
      snippet: "Current weather and forecast.",
      provider: "anysearch",
    });
  });

  it("ignores malformed entries without URLs", () => {
    expect(parseAnySearchMarkdown("### 1. Missing URL\nNo result here.")).toEqual([]);
  });
});
