import { describe, it, expect } from "vitest";
import { listTrials, getTrialById } from "../services/trial-service.js";
import { getTrialSummary } from "../services/analysis-service.js";

describe("trial-service", () => {
  describe("getTrialById", () => {
    it("returns a trial for a valid ID", () => {
      const trial = getTrialById("NCT-001");
      expect(trial).toBeDefined();
      expect(trial!.name).toBe("AURORA-1: Pocenbrodib in mCRPC");
    });

    it("returns undefined for an invalid ID", () => {
      const trial = getTrialById("NCT-999");
      expect(trial).toBeUndefined();
    });
  });

  describe("listTrials", () => {
    it("returns all trials when no filters are applied", () => {
      const result = listTrials({});
      expect(result.trials.length).toBeGreaterThan(0);
      expect(result.total).toBe(result.trials.length);
    });

    it("filters by phase", () => {
      const result = listTrials({ phase: "III" });
      expect(result.trials.every((t) => t.phase === "III")).toBe(true);
    });

    it("filters by status", () => {
      const result = listTrials({ status: "completed" });
      expect(result.trials.every((t) => t.status === "completed")).toBe(true);
    });

    it("filters by minEnrollment", () => {
      const result = listTrials({ minEnrollment: 400 });
      expect(result.trials.every((t) => t.enrollment >= 400)).toBe(true);
      expect(result.trials.length).toBeGreaterThan(0);
    });

    it("applies filter when minEnrollment is 0", () => {
      const result = listTrials({ minEnrollment: 0 });
      expect(result.total).toBeGreaterThan(0);
    });

    it("sorts by startDate descending by default", () => {
      const result = listTrials({ sort: "startDate" });
      const dates = result.trials.map((t) => new Date(t.startDate).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]! <= dates[i - 1]!).toBe(true);
      }
    });

    it("sorts by startDate ascending when order=asc", () => {
      const result = listTrials({ sort: "startDate", order: "asc" });
      const dates = result.trials.map((t) => new Date(t.startDate).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]! >= dates[i - 1]!).toBe(true);
      }
    });

    it("sorts by enrollment ascending", () => {
      const result = listTrials({ sort: "enrollment", order: "asc" });
      const enrollments = result.trials.map((t) => t.enrollment);
      for (let i = 1; i < enrollments.length; i++) {
        expect(enrollments[i]! >= enrollments[i - 1]!).toBe(true);
      }
    });

    describe("search", () => {
      it("matches terms inside keyFindings sentences", () => {
        const result = listTrials({ search: "fatigue" });
        expect(result.trials.length).toBeGreaterThan(0);
        expect(result.trials.some((t) => t.id === "NCT-001")).toBe(true);
      });

      it("ranks results by relevance when no explicit sort is given", () => {
        const result = listTrials({ search: "biliary" });
        expect(result.trials.length).toBeGreaterThan(1);
        expect(result.trials[0]!.id).toBe("NCT-008");
      });

      it("does not attach _score to cached trial objects", () => {
        listTrials({ search: "prostate" });
        const trial = getTrialById("NCT-001");
        expect(trial).not.toHaveProperty("_score");
      });
    });
  });
});

describe("analysis-service", () => {
  describe("getTrialSummary", () => {
    it("does not throw for trials with null responseRate", () => {
      const trial = getTrialById("NCT-003")!;
      expect(() => getTrialSummary(trial)).not.toThrow();
    });

    it("includes 'Not yet available' when responseRate is null", () => {
      const summary = getTrialSummary(getTrialById("NCT-003")!);
      expect(summary.summary).toContain("Not yet available");
    });
  });
});
