import { describe, expect, it, vi } from "vitest";
import { getTrialById } from "../services/trial-service.js";
import type { ClinicalTrial } from "../types.js";

const { mockStreamText, mockOpenai } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockOpenai: vi.fn(() => "mock-model"),
}));

vi.mock("ai", () => ({
  streamText: mockStreamText,
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: mockOpenai,
}));

import { getTrialSummary, streamAnalysis } from "../services/analysis-service.js";

describe("analysis-service", () => {
  describe("calculateRiskScore via getTrialSummary", () => {
    it("does not add risk for a trial with high response rate", () => {
      const baseTrial: ClinicalTrial = {
        id: "TEST-001",
        name: "Test Trial",
        sponsor: "Pathos Therapeutics",
        phase: "II",
        status: "recruiting",
        indication: "Test indication",
        primaryEndpoint: "Test endpoint",
        enrollment: 100,
        startDate: "2024-01-01",
        estimatedCompletionDate: "2025-01-01",
        adverseEventRate: 25,
        responseRate: 61.3,
        keyFindings: ["Test finding"],
      };

      const lowResponseTrial: ClinicalTrial = {
        ...baseTrial,
        id: "TEST-002",
        responseRate: 10,
      };

      const highResponseSummary = getTrialSummary(baseTrial);
      const lowResponseSummary = getTrialSummary(lowResponseTrial);

      expect(highResponseSummary.riskScore).toBeLessThan(lowResponseSummary.riskScore);
    });
  });

  describe("streamAnalysis", () => {
    it("always calls end() when streaming fails", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "partial chunk";
          throw new Error("Simulated stream failure");
        })(),
      });

      let ended = false;
      const writes: string[] = [];
      const mockResponse = {
        writeHead: () => {},
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        end: () => {
          ended = true;
        },
      };

      const trial = getTrialById("NCT-001")!;

      await streamAnalysis(trial, "safety", mockResponse);

      expect(ended).toBe(true);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.some((chunk) => chunk.includes('"error":"Simulated stream failure"'))).toBe(true);
    });
  });
});