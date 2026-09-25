import { describe, expect, it } from "vitest";
import { ResearchSessionStore } from "../src/research-session.js";
import type { ResearchResult } from "../src/types.js";

function result(answer: string, url: string): ResearchResult {
  return {
    query: "test",
    provider: "deepseek-native",
    answerMarkdown: answer,
    sources: [{ url, provider: "deepseek-native" }],
    nativeSearchRequests: 1,
    nativeSearchCalls: [],
    warnings: [],
    degraded: false,
  };
}

describe("research sessions", () => {
  it("starts, appends, and closes isolated sessions", () => {
    const store = new ResearchSessionStore(60_000, 2);
    const first = store.start({ query: "first", maxTurns: 2 }, result("answer-1", "https://a"));
    const second = store.start({ query: "second", maxTurns: 2 }, result("answer-2", "https://b"));

    expect(first.id).not.toBe(second.id);
    store.append(store.get(first.id), "follow-up", result("answer-1b", "https://a"));
    expect(store.get(first.id).turn).toBe(2);
    expect(store.get(first.id).sources).toHaveLength(1);
    expect(store.get(second.id).turn).toBe(1);
    expect(store.close(first.id)).toBe(true);
    expect(() => store.get(first.id)).toThrow(/not found.*expired/iu);
  });

  it("evicts the oldest session when the session limit is reached", () => {
    const store = new ResearchSessionStore(60_000, 1);
    const first = store.start({ query: "first", maxTurns: 2 }, result("a", "https://a"));
    store.start({ query: "second", maxTurns: 2 }, result("b", "https://b"));
    expect(() => store.get(first.id)).toThrow(/not found.*expired/iu);
  });
});
