import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import {
  buildNativeSearchPrompt,
  mapDeepSeekAnthropicResponse,
} from "../src/providers/deepseek-native.js";

describe("DeepSeek Anthropic response mapping", () => {
  it("asks the native provider to prefer primary sources and distrust page content", () => {
    const prompt = buildNativeSearchPrompt("test query");
    expect(prompt).toContain("primary and official sources");
    expect(prompt).toContain("untrusted data");
  });

  it("maps structured search results and citation snippets", () => {
    const result = mapDeepSeekAnthropicResponse(
      {
        content: [
          {
            type: "server_tool_use",
            id: "srv_1",
            name: "web_search",
            input: { query: "Shanghai weather" },
          },
          {
            type: "web_search_tool_result",
            content: [
              {
                type: "web_search_result",
                url: "https://weather.example.com/shanghai",
                title: "Shanghai Weather",
                page_age: "2026-09-17",
              },
            ],
          },
          {
            type: "text",
            text: "Shanghai is mild today.",
            citations: [
              {
                url: "https://weather.example.com/shanghai",
                cited_text: "Mild with a brief shower.",
              },
            ],
          },
        ],
        usage: {
          server_tool_use: { web_search_requests: 1 },
        },
      },
      5,
    );

    expect(result.answerMarkdown).toBe("Shanghai is mild today.");
    expect(result.nativeSearchRequests).toBe(1);
    expect(result.nativeSearchCalls).toEqual([
      { type: "server_tool_use", id: "srv_1", query: "Shanghai weather" },
    ]);
    expect(result.sources[0]).toMatchObject({
      title: "Shanghai Weather",
      url: "https://weather.example.com/shanghai",
      snippet: "Mild with a brief shower.",
      publishedAt: "2026-09-17",
      provider: "deepseek-native",
    });
  });

  it("rejects a DSML-only pseudo search response", () => {
    expect(() =>
      mapDeepSeekAnthropicResponse(
        {
          content: [
            {
              type: "text",
              text: '<｜DSML｜tool_calls><｜DSML｜invoke name="search"></｜DSML｜invoke></｜DSML｜tool_calls>',
            },
          ],
        },
        5,
      ),
    ).toThrowError(ProviderError);
  });

  it("rejects result blocks without citeable items", () => {
    expect(() =>
      mapDeepSeekAnthropicResponse(
        {
          content: [{ type: "web_search_tool_result", content: [] }],
        },
        5,
      ),
    ).toThrowError(/without any citeable web_search_result items/u);
  });
});
