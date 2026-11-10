import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  DECISIONS_KEEP_ABOVE,
  DECISIONS_VETO_BELOW,
  DocsIntentResolver,
  PROMPT_VERSION,
  type CachedDocsIntent,
  type DecisionsTransport,
  type DocsIntentCache,
  type DocsIntentResolution,
} from "../src/docs-intent.js";
import { ProviderError } from "../src/errors.js";
import {
  DOCS_INTENT_QUESTION,
  OpenRouterDecisions,
} from "../src/providers/openrouter-decisions.js";
import type { DecisionsReport } from "../src/types.js";

interface FakeTransport extends DecisionsTransport {
  calls: number;
  queries: string[];
  options: Array<{ timeoutMs: number; signal?: AbortSignal }>;
}

function fakeTransport(
  probability: number | Error,
  extras: { annotations?: number; model?: string; elapsedMs?: number } = {},
): FakeTransport {
  const fake: FakeTransport = {
    calls: 0,
    queries: [],
    options: [],
    async classifyDocsIntent(query, options) {
      fake.calls += 1;
      fake.queries.push(query);
      fake.options.push(options);
      if (probability instanceof Error) throw probability;
      return {
        p: probability,
        annotations: extras.annotations ?? 3,
        elapsedMs: extras.elapsedMs ?? 12,
        ...(extras.model === undefined ? {} : { model: extras.model }),
      };
    },
  };
  return fake;
}

function fakeCache(): DocsIntentCache & { entries: Map<string, CachedDocsIntent> } {
  const entries = new Map<string, CachedDocsIntent>();
  return {
    entries,
    get(key) {
      return entries.get(key);
    },
    set(key, value) {
      entries.set(key, value);
    },
  };
}

function docsQuery(): string {
  return "official Node.js fetch API reference";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocsIntentResolver gating (no network calls)", () => {
  it("does nothing and calls nothing when the feature is off", async () => {
    const transport = fakeTransport(0.05);
    const report = await new DocsIntentResolver(loadConfig({}), transport)
      .resolve(docsQuery(), "balanced", true);

    expect(transport.calls).toBe(0);
    expect(report).toMatchObject({
      mode: "off",
      applied: false,
      verdict: "fallback",
      fallbackReason: "mode_off",
      regexOfficialIntent: true,
      resolvedOfficialIntent: true,
      cached: false,
      elapsedMs: 0,
    });
    expect(report.p).toBeUndefined();
    expect(report.annotations).toBeUndefined();
  });

  it("never calls the model for requested quality=fast", async () => {
    const transport = fakeTransport(0.05);
    const report = await new DocsIntentResolver(loadConfig({ DECISIONS_MODE: "on" }), transport)
      .resolve(docsQuery(), "fast", true);

    expect(transport.calls).toBe(0);
    expect(report.mode).toBe("on");
    expect(report.applied).toBe(false);
    expect(report.verdict).toBe("fallback");
    expect(report.fallbackReason).toBe("requested_quality_fast");
    expect(report.resolvedOfficialIntent).toBe(true);
  });

  it("never promotes a regex-negative query and makes no call", async () => {
    const transport = fakeTransport(0.99);
    const report = await new DocsIntentResolver(loadConfig({ DECISIONS_MODE: "on" }), transport)
      .resolve("best pizza in Shanghai", "deep", false);

    expect(transport.calls).toBe(0);
    expect(report.fallbackReason).toBe("regex_negative");
    expect(report.regexOfficialIntent).toBe(false);
    expect(report.resolvedOfficialIntent).toBe(false);
    expect(report.applied).toBe(false);
  });
});

describe("DocsIntentResolver veto/keep/dead band (mode=on)", () => {
  it("vetoes the regex on a confident low probability", async () => {
    const transport = fakeTransport(0.12, { annotations: 2, model: "parallel/decisions-fast:free" });
    const signal = new AbortController().signal;
    const report = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on", OPENROUTER_API_KEY: "test-key" }),
      transport,
    ).resolve(docsQuery(), "balanced", true, signal);

    expect(transport.calls).toBe(1);
    expect(transport.queries).toEqual([docsQuery()]);
    expect(transport.options[0]?.timeoutMs).toBe(4_000);
    expect(transport.options[0]?.signal).toBe(signal);
    expect(report).toMatchObject({
      mode: "on",
      applied: true,
      verdict: "veto",
      p: 0.12,
      threshold: 0.3,
      regexOfficialIntent: true,
      resolvedOfficialIntent: false,
      cached: false,
      elapsedMs: 12,
      annotations: 2,
    });
    expect(report.fallbackReason).toBeUndefined();
  });

  it("keeps the regex on a confident high probability", async () => {
    const report = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on" }),
      fakeTransport(0.87),
    ).resolve(docsQuery(), "balanced", true);

    expect(report).toMatchObject({
      applied: true,
      verdict: "keep",
      p: 0.87,
      resolvedOfficialIntent: true,
    });
  });

  it("falls back to the regex inside the dead band", async () => {
    for (const probability of [0.3, DECISIONS_VETO_BELOW, DECISIONS_KEEP_ABOVE]) {
      const report = await new DocsIntentResolver(
        loadConfig({ DECISIONS_MODE: "on" }),
        fakeTransport(probability),
      ).resolve(docsQuery(), "deep", true);

      expect(report.verdict).toBe("fallback");
      expect(report.applied).toBe(false);
      expect(report.p).toBe(probability);
      expect(report.resolvedOfficialIntent).toBe(true);
      expect(report.fallbackReason).toBe("dead_band");
    }
  });

  it("respects the exact dead-band edges", async () => {
    const justBelowVeto = 0.249;
    const justAboveKeep = 0.401;
    const config = loadConfig({ DECISIONS_MODE: "on" });

    const veto = await new DocsIntentResolver(config, fakeTransport(justBelowVeto))
      .resolve(docsQuery(), "balanced", true);
    const keep = await new DocsIntentResolver(config, fakeTransport(justAboveKeep))
      .resolve(docsQuery(), "balanced", true);

    expect(veto.verdict).toBe("veto");
    expect(keep.verdict).toBe("keep");
  });
});

describe("DocsIntentResolver shadow mode", () => {
  it("always resolves to the regex while recording the model verdict", async () => {
    const transport = fakeTransport(0.02);
    const report = await new DocsIntentResolver(loadConfig({ DECISIONS_MODE: "shadow" }), transport)
      .resolve(docsQuery(), "balanced", true);

    expect(transport.calls).toBe(1);
    expect(report.mode).toBe("shadow");
    expect(report.verdict).toBe("veto");
    expect(report.p).toBe(0.02);
    expect(report.applied).toBe(false);
    expect(report.resolvedOfficialIntent).toBe(true);
  });

  it("keeps the regex for a keep verdict and for the dead band", async () => {
    for (const [probability, verdict] of [[0.95, "keep"], [0.33, "fallback"]] as const) {
      const report = await new DocsIntentResolver(
        loadConfig({ DECISIONS_MODE: "shadow" }),
        fakeTransport(probability),
      ).resolve(docsQuery(), "deep", true);

      expect(report.verdict).toBe(verdict);
      expect(report.applied).toBe(false);
      expect(report.resolvedOfficialIntent).toBe(true);
    }
  });
});

describe("DocsIntentResolver cache", () => {
  it("reuses a cached probability instead of calling twice", async () => {
    const transport = fakeTransport(0.91);
    const cache = fakeCache();
    const config = loadConfig({ DECISIONS_MODE: "on" });
    const resolver = new DocsIntentResolver(config, transport, cache);

    const first = await resolver.resolve("Node  Fetch API  docs", "balanced", true);
    const second = await resolver.resolve("node fetch api docs", "balanced", true);

    expect(transport.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.verdict).toBe("keep");
    expect(second.p).toBe(0.91);
    expect(second.elapsedMs).toBe(0);
    expect(cache.entries.size).toBe(1);
    const entry = [...cache.entries.values()][0]!;
    expect(entry.p).toBe(0.91);
    expect(entry.annotations).toBe(3);
  });

  it("shares the cache across resolver instances with the same model", async () => {
    const transport = fakeTransport(0.08);
    const cache = fakeCache();
    const config = loadConfig({ DECISIONS_MODE: "on" });
    await new DocsIntentResolver(config, transport, cache)
      .resolve(docsQuery(), "balanced", true);
    const second = await new DocsIntentResolver(config, transport, cache)
      .resolve(docsQuery(), "balanced", true);

    expect(transport.calls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.verdict).toBe("veto");
  });

  it("keys the cache by decisions model", async () => {
    const transport = fakeTransport(0.08);
    const cache = fakeCache();
    await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on", OPENROUTER_DECISIONS_MODEL: "model-a" }),
      transport,
      cache,
    ).resolve(docsQuery(), "balanced", true);
    const second = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on", OPENROUTER_DECISIONS_MODEL: "model-b" }),
      transport,
      cache,
    ).resolve(docsQuery(), "balanced", true);

    expect(transport.calls).toBe(2);
    expect(second.cached).toBe(false);
    expect(cache.entries.size).toBe(2);
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

describe("DocsIntentResolver fallbacks (never throws)", () => {
  it("falls back to the regex when the transport reports an invalid response", async () => {
    const transport = fakeTransport(new ProviderError(
      "openrouter-decisions",
      "invalid_response",
      "answers.is_documentation.type is refusal instead of noul",
    ));
    const report = await new DocsIntentResolver(loadConfig({ DECISIONS_MODE: "on" }), transport)
      .resolve(docsQuery(), "balanced", true);

    expect(report.mode).toBe("on");
    expect(report.applied).toBe(false);
    expect(report.verdict).toBe("fallback");
    expect(report.resolvedOfficialIntent).toBe(true);
    expect(report.cached).toBe(false);
    expect(report.p).toBeUndefined();
    expect(report.fallbackReason).toContain("transport_error");
    expect(report.fallbackReason).toContain("refusal");
  });

  it("falls back on a timeout without throwing", async () => {
    const report = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on" }),
      fakeTransport(new ProviderError("openrouter-decisions", "timeout", "timed out after 2500ms")),
    ).resolve(docsQuery(), "balanced", true);

    expect(report.verdict).toBe("fallback");
    expect(report.resolvedOfficialIntent).toBe(true);
    expect(report.fallbackReason).toContain("timed out");
  });

  it("falls back on a generic error and on an out-of-range probability", async () => {
    const thrown = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "shadow" }),
      fakeTransport(new Error("socket hang up")),
    ).resolve(docsQuery(), "balanced", true);
    const outOfRange = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on" }),
      fakeTransport(Number.NaN),
    ).resolve(docsQuery(), "deep", true);

    expect(thrown.verdict).toBe("fallback");
    expect(thrown.resolvedOfficialIntent).toBe(true);
    expect(thrown.fallbackReason).toContain("socket hang up");
    expect(outOfRange.verdict).toBe("fallback");
    expect(outOfRange.fallbackReason).toBe("invalid_response");
    expect(outOfRange.applied).toBe(false);
  });
});

describe("DocsIntentResolver configuration", () => {
  it("reports the configured threshold without moving the dead band", async () => {
    const report = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "on", OPENROUTER_DECISIONS_THRESHOLD: "0.35" }),
      fakeTransport(0.3),
    ).resolve(docsQuery(), "balanced", true);

    expect(report.threshold).toBe(0.35);
    expect(report.verdict).toBe("fallback");
    expect(report.resolvedOfficialIntent).toBe(true);
  });

  it("supports the DECISIONS_MODE alias and lets the canonical env win", async () => {
    expect(loadConfig({ DECISIONS_MODE: "shadow" }).decisionsMode).toBe("shadow");
    expect(loadConfig({
      DECISIONS_MODE: "off",
      WEB_SEARCH_DECISIONS_MODE: "on",
    }).decisionsMode).toBe("on");

    const report = await new DocsIntentResolver(
      loadConfig({ DECISIONS_MODE: "shadow" }),
      fakeTransport(0.05),
    ).resolve(docsQuery(), "balanced", true);

    // DocsIntentResolution is an alias of the shared DecisionsReport contract.
    const asDecisionsReport: DecisionsReport = report;
    expect(asDecisionsReport.mode).toBe("shadow");
    expect(asDecisionsReport.applied).toBe(false);

    const typedResolution: DocsIntentResolution = report;
    expect(typedResolution.resolvedOfficialIntent).toBe(true);
  });
});

describe("OpenRouterDecisions provider", () => {
  function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("posts the noul docs-intent question and parses the probability", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        state: { query: string };
        questions: {
          is_documentation: {
            type: string;
            instructions: string;
            criteria: { true: string; false: string };
          };
        };
      };
      expect(body.model).toBe("parallel/decisions-fast:free");
      expect(body.state.query).toBe("Which Node.js version ships fetch?");
      expect(body.questions.is_documentation.type).toBe("noul");
      expect(body.questions.is_documentation.instructions).toBe(DOCS_INTENT_QUESTION.instructions);
      expect(body.questions.is_documentation.criteria).toEqual(DOCS_INTENT_QUESTION.criteria);
      return jsonResponse({
        model: "parallel/decisions-fast:free",
        annotations: [{ type: "citation" }, { type: "citation" }],
        answers: { is_documentation: { type: "noul", noul: 0.87 } },
        usage: { total_tokens: 31 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterDecisions(loadConfig({ OPENROUTER_API_KEY: "test-key" }));
    const result = await provider.classifyDocsIntent(
      "Which Node.js version ships fetch?",
      { timeoutMs: 4_000 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.p).toBe(0.87);
    expect(result.annotations).toBe(2);
    expect(result.model).toBe("parallel/decisions-fast:free");
    expect(result.usage).toEqual({ total_tokens: 31 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["a refusal", { answers: { is_documentation: { type: "refusal" } } }],
    ["a missing answer", { answers: {} }],
    ["a missing answers object", {}],
    ["a non-noul answer type", { answers: { is_documentation: { type: "boolean", boolean: true } } }],
    ["an out-of-range noul", { answers: { is_documentation: { type: "noul", noul: 1.4 } } }],
    ["a non-numeric noul", { answers: { is_documentation: { type: "noul", noul: "0.8" } } }],
    ["a non-object body", "not-json-object"],
  ])("rejects %s as invalid_response", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload)));
    const provider = new OpenRouterDecisions(loadConfig({ OPENROUTER_API_KEY: "test-key" }));

    await expect(
      provider.classifyDocsIntent("node docs", { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "openrouter-decisions",
      code: "invalid_response",
    });
  });

  it("rejects a missing API key without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenRouterDecisions(loadConfig({ DECISIONS_MODE: "on" }));

    await expect(
      provider.classifyDocsIntent("node docs", { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "missing_credential" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a hanging request to a timeout error", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    )));
    const provider = new OpenRouterDecisions(loadConfig({ OPENROUTER_API_KEY: "test-key" }));

    await expect(
      provider.classifyDocsIntent("node docs", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ provider: "openrouter-decisions", code: "timeout" });
  });

  it("enforces the local decisions per-minute budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      answers: { is_documentation: { type: "noul", noul: 0.9 } },
    })));
    const provider = new OpenRouterDecisions(loadConfig({
      OPENROUTER_API_KEY: "test-key",
      WEB_SEARCH_DECISIONS_MAX_CALLS_PER_MINUTE: "2",
    }));

    await provider.classifyDocsIntent("docs one", { timeoutMs: 1_000 });
    await provider.classifyDocsIntent("docs two", { timeoutMs: 1_000 });

    await expect(
      provider.classifyDocsIntent("docs three", { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ provider: "openrouter-decisions", code: "rate_limited" });
  });
});
