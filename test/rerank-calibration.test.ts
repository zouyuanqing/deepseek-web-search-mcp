import { describe, expect, it } from "vitest";
import {
  RERANK_NEW_MODEL_ID,
  RERANK_NEW_TIMEOUT_MS,
  RERANK_OLD_MODEL_ID,
  RERANK_OLD_TIMEOUT_MS,
  calibrateRerankScores,
  normalizeRerankModelId,
  resolveRerankProfile,
  resolveRerankTimeoutMs,
} from "../src/rerank-calibration.js";

const NEW_MODEL = "nvidia/nemotron-3.5-rerank-8b:free";
const OLD_MODEL = "nvidia/llama-nemotron-rerank-vl-1b-v2:free";

describe("rerank model ids", () => {
  it("strips the :free suffix and trailing build dates", () => {
    expect(normalizeRerankModelId("nvidia/nemotron-3.5-rerank-8b:free")).toBe(RERANK_NEW_MODEL_ID);
    expect(normalizeRerankModelId("nvidia/nemotron-3.5-rerank-8b-20260115")).toBe(RERANK_NEW_MODEL_ID);
    expect(normalizeRerankModelId("nvidia/nemotron-3.5-rerank-8b:free-20260115")).toBe(RERANK_NEW_MODEL_ID);
    expect(normalizeRerankModelId("nvidia/nemotron-3.5-rerank-8b-20260115:free")).toBe(RERANK_NEW_MODEL_ID);
    expect(normalizeRerankModelId("  Nvidia/Nemotron-3.5-Rerank-8B:Free  ")).toBe(RERANK_NEW_MODEL_ID);
    expect(normalizeRerankModelId(RERANK_OLD_MODEL_ID)).toBe(RERANK_OLD_MODEL_ID);
    // A 4-digit year is not a build date and must survive.
    expect(normalizeRerankModelId("nvidia/model-2026")).toBe("nvidia/model-2026");
    expect(normalizeRerankModelId("")).toBe("");
  });

  it("resolves the calibration profile from the model family", () => {
    expect(resolveRerankProfile(NEW_MODEL)).toBe("minmax");
    expect(resolveRerankProfile("nvidia/nemotron-3.5-rerank-8b-20260115")).toBe("minmax");
    expect(resolveRerankProfile(OLD_MODEL)).toBe("raw");
    expect(resolveRerankProfile("openai/unknown-rerank-model")).toBe("raw");
    expect(resolveRerankProfile("")).toBe("raw");
  });
});

describe("rerank timeouts", () => {
  it("uses the model profile when no timeout is configured", () => {
    expect(RERANK_NEW_TIMEOUT_MS).toBe(12_000);
    expect(RERANK_OLD_TIMEOUT_MS).toBe(5_000);
    expect(resolveRerankTimeoutMs(NEW_MODEL, 0)).toBe(RERANK_NEW_TIMEOUT_MS);
    expect(resolveRerankTimeoutMs(OLD_MODEL, 0)).toBe(RERANK_OLD_TIMEOUT_MS);
    expect(resolveRerankTimeoutMs("unknown/model", 0)).toBe(RERANK_OLD_TIMEOUT_MS);
  });

  it("prefers an explicit positive timeout and ignores invalid values", () => {
    expect(resolveRerankTimeoutMs(NEW_MODEL, 2_500)).toBe(2_500);
    expect(resolveRerankTimeoutMs(NEW_MODEL, -1)).toBe(RERANK_NEW_TIMEOUT_MS);
    expect(resolveRerankTimeoutMs(NEW_MODEL, Number.NaN)).toBe(RERANK_NEW_TIMEOUT_MS);
    expect(resolveRerankTimeoutMs(OLD_MODEL, 9_000)).toBe(9_000);
  });
});

describe("rerank score calibration", () => {
  it("clamps raw scores without normalizing", () => {
    const report = calibrateRerankScores(
      [1.5, -0.2, Number.NaN, Number.POSITIVE_INFINITY],
      "raw",
      NEW_MODEL,
    );
    expect(report.scores).toEqual([1, 0, 0, 0]);
    expect(report.mode).toBe("raw");
    expect(report.applied).toBe(false);
    expect(report.signalQuality).toBe("strong");
    expect(report.rawMin).toBe(0);
    expect(report.rawMax).toBe(1);
    expect(report.spread).toBe(1);
  });

  it("resolves auto from the model profile", () => {
    const compressed = [0.015, 0.12, 0.262];
    const newReport = calibrateRerankScores(compressed, "auto", NEW_MODEL);
    expect(newReport.mode).toBe("minmax");
    expect(newReport.applied).toBe(true);
    expect(newReport.signalQuality).toBe("strong");

    const oldReport = calibrateRerankScores([0.9, 0.4, 0.2], "auto", OLD_MODEL);
    expect(oldReport.mode).toBe("raw");
    expect(oldReport.applied).toBe(false);
    expect(oldReport.scores).toEqual([0.9, 0.4, 0.2]);

    const unknownReport = calibrateRerankScores(compressed, "auto", "someone/unknown");
    expect(unknownReport.mode).toBe("raw");
    expect(unknownReport.scores).toEqual(compressed);
  });

  it("min-max normalizes a compressed but informative distribution", () => {
    const report = calibrateRerankScores([0.015, 0.12, 0.262], "minmax", NEW_MODEL);
    expect(report.applied).toBe(true);
    expect(report.signalQuality).toBe("strong");
    expect(report.rawMin).toBeCloseTo(0.015, 10);
    expect(report.rawMax).toBeCloseTo(0.262, 10);
    expect(report.spread).toBeCloseTo(0.247, 10);
    expect(report.scores[0]).toBe(0);
    expect(report.scores[1]).toBeCloseTo(0.105 / 0.247, 10);
    expect(report.scores[2]).toBe(1);
  });

  it("zeroes a collapsed all-junk distribution and marks it weak", () => {
    const report = calibrateRerankScores([0.015, 0.018, 0.02], "auto", NEW_MODEL);
    expect(report.mode).toBe("minmax");
    expect(report.applied).toBe(false);
    expect(report.signalQuality).toBe("weak");
    expect(report.scores).toEqual([0, 0, 0]);
    expect(report.spread).toBeCloseTo(0.005, 10);
  });

  it("guards against a collapsed spread relative to the maximum", () => {
    const report = calibrateRerankScores([0.9, 0.91, 0.92], "minmax", NEW_MODEL);
    expect(report.applied).toBe(false);
    expect(report.signalQuality).toBe("weak");
    expect(report.scores).toEqual([0, 0, 0]);
  });

  it("guards against a low absolute maximum", () => {
    const report = calibrateRerankScores([0.02, 0.05, 0.07], "minmax", NEW_MODEL);
    expect(report.applied).toBe(false);
    expect(report.signalQuality).toBe("weak");
    expect(report.scores).toEqual([0, 0, 0]);
  });

  it("falls back to raw when there are too few samples", () => {
    const report = calibrateRerankScores([0.1, 0.9], "minmax", NEW_MODEL);
    expect(report.applied).toBe(false);
    expect(report.scores).toEqual([0.1, 0.9]);
    expect(report.rawMin).toBeCloseTo(0.1, 10);
    expect(report.signalQuality).toBe("strong");
  });

  it("falls back to raw when every score is identical", () => {
    const report = calibrateRerankScores([0.5, 0.5, 0.5], "minmax", NEW_MODEL);
    expect(report.applied).toBe(false);
    expect(report.scores).toEqual([0.5, 0.5, 0.5]);
    expect(report.signalQuality).toBe("strong");
  });

  it("reports no score range for an empty score list", () => {
    const report = calibrateRerankScores([], "auto", NEW_MODEL);
    expect(report.scores).toEqual([]);
    expect(report.mode).toBe("minmax");
    expect(report.applied).toBe(false);
    expect(report.rawMin).toBeUndefined();
    expect(report.rawMax).toBeUndefined();
    expect(report.spread).toBeUndefined();
  });
});
