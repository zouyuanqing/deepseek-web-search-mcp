import type { AppConfig } from "../config.js";
import { ProviderError } from "../errors.js";
import { OpenRouterClient } from "./openrouter-client.js";

/** Request options accepted by a decisions transport. */
export interface DecisionsRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Validated output of a single docs-intent classification call. */
export interface DecisionsClassification {
  /** Noul probability in [0, 1] that the query asks for project documentation. */
  p: number;
  annotations: number;
  elapsedMs: number;
  model?: string;
  usage?: Record<string, unknown>;
}

/**
 * Transport abstraction for the docs-intent veto. Only the resolver decides
 * when a call is worth making; a transport performs exactly one classification.
 */
export interface DecisionsTransport {
  classifyDocsIntent(
    query: string,
    options: DecisionsRequestOptions,
  ): Promise<DecisionsClassification>;
}

const DECISIONS_PROVIDER = "openrouter-decisions" as const;
const DECISIONS_PATH = "/api/alpha/decisions";

/**
 * The noul question probe for the veto. Copy is part of the cache identity via
 * `PROMPT_VERSION` in docs-intent.ts; changing the question requires bumping it
 * so stale probabilities are not reused.
 */
export const DOCS_INTENT_QUESTION = {
  type: "noul",
  instructions:
    "Is the user asking for official documentation, API reference, source code, release notes or changelog of a software project?",
  criteria: {
    true:
      "The query asks for a software project's own documentation, API reference, source code, release notes, or changelog.",
    false:
      "The query asks for general information, news, tutorials, comparisons, or opinions rather than a software project's own documentation or release artifacts.",
  },
} as const;

function invalidResponse(detail: string): ProviderError {
  return new ProviderError(
    DECISIONS_PROVIDER,
    "invalid_response",
    `openrouter-decisions returned an invalid response: ${detail}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * OpenRouter decisions (`parallel/decisions-fast:free`) transport.
 *
 * The endpoint answers a set of typed questions; the docs-intent veto only
 * needs `is_documentation` as a noul probability. Anything else — a refusal,
 * a missing answer, a different answer type or an out-of-range value — is
 * rejected as `invalid_response` so the resolver can fall back to the regex.
 */
export class OpenRouterDecisions implements DecisionsTransport {
  private readonly client: OpenRouterClient;
  private readonly callTimestamps: number[] = [];

  constructor(
    private readonly config: AppConfig,
    client?: OpenRouterClient,
  ) {
    this.client = client ?? new OpenRouterClient(config);
  }

  private assertCredential(): void {
    if (this.config.openRouterApiKey === undefined) {
      throw new ProviderError(
        DECISIONS_PROVIDER,
        "missing_credential",
        "OPENROUTER_API_KEY is not configured",
      );
    }
  }

  /**
   * Decisions are optional advisory context, so they get their own conservative
   * allowance (`decisionsMaxCallsPerMinute`) instead of competing for the
   * shared OpenRouter budget. Exhausting it fails closed: the resolver falls
   * back to the regex and never delays the search.
   */
  private consumeCallBudget(now = Date.now()): void {
    const windowStart = now - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0]! < windowStart) {
      this.callTimestamps.shift();
    }
    if (this.callTimestamps.length >= this.config.decisionsMaxCallsPerMinute) {
      throw new ProviderError(
        DECISIONS_PROVIDER,
        "rate_limited",
        `openrouter-decisions local budget of ${this.config.decisionsMaxCallsPerMinute} call(s)/minute is exhausted`,
        { retryable: true },
      );
    }
    this.callTimestamps.push(now);
  }

  async classifyDocsIntent(
    query: string,
    options: DecisionsRequestOptions,
  ): Promise<DecisionsClassification> {
    this.assertCredential();
    this.consumeCallBudget();
    const result = await this.client.post<unknown>(
      DECISIONS_PROVIDER,
      DECISIONS_PATH,
      {
        model: this.config.openRouterDecisionsModel,
        state: { query },
        questions: {
          is_documentation: DOCS_INTENT_QUESTION,
        },
      },
      {
        timeoutMs: options.timeoutMs,
        circuitCooldownMs: this.config.decisionsCircuitCooldownMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    const payload = asRecord(result.data);
    if (payload === undefined) throw invalidResponse("body is not a JSON object");
    const answers = asRecord(payload.answers);
    if (answers === undefined) throw invalidResponse("answers object is missing");
    const answer = asRecord(answers.is_documentation);
    if (answer === undefined) throw invalidResponse("answers.is_documentation is missing");
    if (answer.type !== "noul") {
      throw invalidResponse(
        `answers.is_documentation.type is ${JSON.stringify(answer.type)} instead of "noul"`,
      );
    }
    const noul = answer.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw invalidResponse("answers.is_documentation.noul is not a probability in [0, 1]");
    }

    const annotations = Array.isArray(payload.annotations)
      ? payload.annotations.length
      : Array.isArray(answer.annotations)
        ? answer.annotations.length
        : 0;
    return {
      p: noul,
      annotations,
      elapsedMs: result.elapsedMs,
      ...(typeof payload.model === "string" && payload.model.length > 0
        ? { model: payload.model }
        : {}),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
}
