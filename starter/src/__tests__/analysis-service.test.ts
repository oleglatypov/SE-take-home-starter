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

  describe("calculateRiskScore boundaries", () => {
    // Base fixture: Phase II, recruiting, responseRate 50 (neutral — not < 20)
    const aeBase: ClinicalTrial = {
      id: "AE-TEST",
      name: "AE Boundary Test",
      sponsor: "Test",
      phase: "II",
      status: "recruiting",
      indication: "Test indication",
      primaryEndpoint: "Test endpoint",
      enrollment: 100,
      startDate: "2024-01-01",
      estimatedCompletionDate: "2025-01-01",
      adverseEventRate: 25,
      responseRate: 50,
      keyFindings: ["finding"],
    };

    it("AE rate exactly 30 applies +1 (threshold is exclusive > 30)", () => {
      // adverseEventRate > 30 → false at exactly 30, so +1 branch
      // Phase II → +0; rr 50 not < 20 → +0; total = 1
      const summary = getTrialSummary({ ...aeBase, adverseEventRate: 30 });
      expect(summary.riskScore).toBe(1);
    });

    it("AE rate 30.1 applies +2 (crosses the > 30 threshold)", () => {
      const summary = getTrialSummary({ ...aeBase, adverseEventRate: 30.1 });
      expect(summary.riskScore).toBe(2);
    });

    it("KNOWN BUG candidate: AE rate exactly 50 applies +2 not +3 (> 50 is exclusive)", () => {
      // The +3 branch fires only when adverseEventRate > 50. At exactly 50, +2 applies.
      // Whether 50% AE rate should trigger the high-risk +3 depends on clinical definition.
      // If the intent is >= 50 → high risk, this is a boundary error.
      const summary = getTrialSummary({ ...aeBase, adverseEventRate: 50 });
      expect(summary.riskScore).toBe(2);
    });

    it("AE rate 50.1 applies +3 (crosses the > 50 threshold)", () => {
      const summary = getTrialSummary({ ...aeBase, adverseEventRate: 50.1 });
      expect(summary.riskScore).toBe(3);
    });

    it("null responseRate does not add risk penalty (no JS null-coercion to 0)", () => {
      // Without the `responseRate !== null &&` guard, null < 20 would be true in JS
      // (null coerces to 0), incorrectly adding +2. Verified the guard holds.
      // AE 25 ≤ 30 → +1; Phase II → +0; null rr → +0; total = 1
      const summary = getTrialSummary({ ...aeBase, adverseEventRate: 25, responseRate: null });
      expect(summary.riskScore).toBe(1);
    });

    it("null responseRate does not trigger the < 20 penalty branch", () => {
      // Explicitly assert the score is NOT 3 (what it would be if null coerced to 0 and triggered +2)
      const summary = getTrialSummary({ ...aeBase, adverseEventRate: 25, responseRate: null });
      expect(summary.riskScore).not.toBe(3);
    });

    it("terminated status adds +3 to risk score", () => {
      // AE 25 ≤ 30 → +1; terminated → +3; Phase II → +0; rr 50 → +0; total = 4
      const summary = getTrialSummary({ ...aeBase, status: "terminated" });
      expect(summary.riskScore).toBe(4);
    });

    it("maximum risk scenario: high AE + terminated + low response rate → 8", () => {
      // AE 55 > 50 → +3; terminated → +3; Phase II → +0; rr 15 < 20 → +2; total = 8
      const summary = getTrialSummary({
        ...aeBase,
        adverseEventRate: 55,
        status: "terminated",
        responseRate: 15,
      });
      expect(summary.riskScore).toBe(8);
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
        write: (chunk: string) => { writes.push(chunk); return true; },
        once: () => {},
        end: () => { ended = true; },
      };

      const trial = getTrialById("NCT-001")!;

      await streamAnalysis(trial, "safety", mockResponse);

      expect(ended).toBe(true);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.some((chunk) => chunk.includes('"error":"Simulated stream failure"'))).toBe(true);
    });

    it("awaits drain when write returns false", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "chunk one";
          yield "chunk two";
        })(),
      });

      let drainCalled = false;
      let writeCount = 0;
      const mockResponse = {
        writeHead: () => {},
        write: (_chunk: string) => {
          writeCount++;
          return writeCount > 1; // first write signals backpressure
        },
        once: (event: string, listener: () => void) => {
          if (event === "drain") {
            drainCalled = true;
            listener(); // immediately resolve so the loop can continue
          }
        },
        end: () => {},
      };

      const trial = getTrialById("NCT-001")!;
      await streamAnalysis(trial, "safety", mockResponse);

      expect(drainCalled).toBe(true);
    });

    it("passes abortSignal to streamText and suppresses abort error writes", async () => {
      const controller = new AbortController();

      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          controller.abort();
          throw new Error("Aborted");
        })(),
      });

      let ended = false;
      const writes: string[] = [];
      const mockResponse = {
        writeHead: () => {},
        write: (chunk: string) => { writes.push(chunk); return true; },
        once: () => {},
        end: () => { ended = true; },
      };

      await streamAnalysis(getTrialById("NCT-001")!, "safety", mockResponse, controller.signal);

      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal })
      );
      expect(ended).toBe(true);
      expect(writes.some((chunk) => chunk.includes('"error"'))).toBe(false);
    });

    it("calls writeHead with 200 and required SSE headers", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "hello";
        })(),
      });

      const headCalls: Array<[number, Record<string, string>]> = [];
      const mockResponse = {
        writeHead: (status: number, headers: Record<string, string>) => {
          headCalls.push([status, headers]);
        },
        write: () => true,
        once: () => {},
        end: () => {},
      };

      await streamAnalysis(getTrialById("NCT-001")!, "safety", mockResponse);

      expect(headCalls).toHaveLength(1);
      expect(headCalls[0]![0]).toBe(200);
      expect(headCalls[0]![1]["Content-Type"]).toBe("text/event-stream");
      expect(headCalls[0]![1]["Cache-Control"]).toBe("no-cache");
      expect(headCalls[0]![1]["Connection"]).toBe("keep-alive");
    });

    it("writes data: [DONE]\\n\\n as the last write on successful stream", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "chunk one";
          yield "chunk two";
        })(),
      });

      const writes: string[] = [];
      const mockResponse = {
        writeHead: () => {},
        write: (chunk: string) => { writes.push(chunk); return true; },
        once: () => {},
        end: () => {},
      };

      await streamAnalysis(getTrialById("NCT-001")!, "efficacy", mockResponse);

      expect(writes[writes.length - 1]).toBe("data: [DONE]\n\n");
    });

    it("SSE chunk format is data: {JSON}\\n\\n (pins wire format)", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "hello";
        })(),
      });

      const writes: string[] = [];
      const mockResponse = {
        writeHead: () => {},
        write: (chunk: string) => { writes.push(chunk); return true; },
        once: () => {},
        end: () => {},
      };

      await streamAnalysis(getTrialById("NCT-001")!, "competitive", mockResponse);

      expect(writes).toContain('data: {"text":"hello"}\n\n');
    });

    it("does NOT write [DONE] when stream throws", async () => {
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "partial";
          throw new Error("upstream failure");
        })(),
      });

      const writes: string[] = [];
      const mockResponse = {
        writeHead: () => {},
        write: (chunk: string) => { writes.push(chunk); return true; },
        once: () => {},
        end: () => {},
      };

      await streamAnalysis(getTrialById("NCT-001")!, "safety", mockResponse);

      expect(writes.some((w) => w.includes("[DONE]"))).toBe(false);
      expect(writes.some((w) => w.includes('"error":'))).toBe(true);
    });
  });
});