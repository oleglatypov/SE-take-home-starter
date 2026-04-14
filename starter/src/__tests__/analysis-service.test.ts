import { describe, expect, it, vi } from "vitest";
import { getTrialById } from "../services/trial-service.js";

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

import { streamAnalysis } from "../services/analysis-service.js";

describe("analysis-service", () => {
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