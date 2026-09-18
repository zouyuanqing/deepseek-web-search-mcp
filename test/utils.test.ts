import { describe, expect, it, vi } from "vitest";
import { normalizeProviderError } from "../src/errors.js";
import {
  canonicalizeUrl,
  dedupeSources,
  OperationTimeoutError,
  resolveScope,
  withTimeout,
} from "../src/utils.js";

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

describe("operation timeouts", () => {
  it("reports a typed timeout and normalizes it to a provider timeout error", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(
      async (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      5,
      "test request",
    );
    const rejection = expect(promise).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(6);
    await rejection;
    vi.useRealTimers();

    const normalized = normalizeProviderError(
      "tavily",
      new OperationTimeoutError("test request timed out"),
    );
    expect(normalized.code).toBe("timeout");
    expect(normalized.retryable).toBe(true);
  });
});
