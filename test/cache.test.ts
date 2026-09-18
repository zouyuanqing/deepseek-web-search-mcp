import { describe, expect, it } from "vitest";
import { hashCacheKey, normalizeCacheQuery, TtlLruCache } from "../src/cache.js";

describe("TTL LRU cache", () => {
  it("returns entries before expiry and removes them after expiry", () => {
    let now = 1_000;
    const cache = new TtlLruCache<string, number>({
      ttlMs: 100,
      maxEntries: 2,
      now: () => now,
    });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    now = 1_100;
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the least recently used entry", () => {
    const cache = new TtlLruCache<string, number>({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => 1_000,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });
});

describe("cache keys", () => {
  it("normalizes query whitespace and case consistently", () => {
    expect(normalizeCacheQuery("  DeepSeek   Search  ")).toBe("deepseek search");
  });

  it("hashes structured keys deterministically", () => {
    expect(hashCacheKey(["search", "DeepSeek", 10]))
      .toBe(hashCacheKey(["search", "DeepSeek", 10]));
    expect(hashCacheKey(["search", "DeepSeek", 10]))
      .not.toBe(hashCacheKey(["search", "DeepSeek", 20]));
  });
});
