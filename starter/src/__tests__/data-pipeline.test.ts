import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deduplicateRecords,
  parseDate,
  processRawCsv,
  redactPii,
  runPipeline,
} from "../services/data-pipeline.js";
import type { NormalizedRecord } from "../services/data-pipeline.js";

function makeNormalizedRecord(overrides: Partial<NormalizedRecord["normalized"]>): NormalizedRecord {
  return {
    raw: {
      patient_id: overrides.patientId ?? "PT-001",
      trial_id: overrides.trialId ?? "NCT-001",
      site_id: overrides.siteId ?? "SITE-A01",
      enrollment_date: overrides.enrollmentDate ?? "2023-04-12",
      age: String(overrides.age ?? 67),
      sex: overrides.sex ?? "M",
      weight_kg: String(overrides.weight ?? 82.3),
      dose_level: overrides.doseLevel ?? "400mg BID",
      adverse_events: (overrides.adverseEvents ?? ["fatigue"]).join(";"),
      lab_notes: overrides.labNotes ?? "baseline note",
      response_assessment: overrides.responseAssessment ?? "partial_response",
      last_visit_date: overrides.lastVisitDate ?? "2024-01-15",
      status: overrides.status ?? "active",
    },
    normalized: {
      patientId: overrides.patientId ?? "PT-001",
      trialId: overrides.trialId ?? "NCT-001",
      siteId: overrides.siteId ?? "SITE-A01",
      enrollmentDate: overrides.enrollmentDate ?? "2023-04-12",
      age: overrides.age ?? 67,
      sex: overrides.sex ?? "M",
      weight: overrides.weight ?? 82.3,
      doseLevel: overrides.doseLevel ?? "400mg BID",
      adverseEvents: overrides.adverseEvents ?? ["fatigue"],
      labNotes: overrides.labNotes ?? "baseline note",
      responseAssessment: overrides.responseAssessment ?? "partial_response",
      lastVisitDate: overrides.lastVisitDate ?? "2024-01-15",
      status: overrides.status ?? "active",
    },
    issues: [],
    quarantineReasons: [],
  };
}

describe("redactPii", () => {
  it("redacts email, MRN, SSN, and named individuals", () => {
    const result = redactPii(
      "Dr. Rachel Kim emailed john.doe@clinic.org about Patient John Williams (MRN: 4451892). SSN: 412-XX-8891. CRA Lisa Park reviewed it."
    );

    expect(result.found).toBe(true);
    expect(result.redacted).toContain("Dr. [NAME REDACTED]");
    expect(result.redacted).toContain("[EMAIL REDACTED]");
    expect(result.redacted).toContain("Patient [NAME REDACTED]");
    expect(result.redacted).toContain("[MRN REDACTED]");
    expect(result.redacted).toContain("[SSN REDACTED]");
    expect(result.redacted).toContain("CRA [NAME REDACTED]");
  });

  it("returns found false when no PII is present", () => {
    const result = redactPii("PSA 12.4 ng/mL at baseline, declining trend");

    expect(result.found).toBe(false);
    expect(result.redacted).toBe("PSA 12.4 ng/mL at baseline, declining trend");
  });
});

describe("parseDate", () => {
  it("passes through ISO dates", () => {
    expect(parseDate("2023-04-12")).toEqual({ iso: "2023-04-12", ambiguous: false });
  });

  it("normalizes slash and text dates", () => {
    expect(parseDate("2023/11/01")).toEqual({ iso: "2023-11-01", ambiguous: false });
    expect(parseDate("Jun 20 2023")).toEqual({ iso: "2023-06-20", ambiguous: false });
    expect(parseDate("04/25/2023")).toEqual({ iso: "2023-04-25", ambiguous: false });
    expect(parseDate("15/05/2024")).toEqual({ iso: "2024-05-15", ambiguous: false });
  });

  it("flags ambiguous slash dates and returns null for empty input", () => {
    expect(parseDate("01/06/2023")).toEqual({ iso: null, ambiguous: true });
    expect(parseDate("")).toBeNull();
  });
});

describe("deduplicateRecords", () => {
  it("keeps the latest conflicting duplicate and quarantines the older row", () => {
    const older = makeNormalizedRecord({
      patientId: "PT-003",
      enrollmentDate: "2023-04-25",
      responseAssessment: "partial_response",
      lastVisitDate: "2024-01-22",
    });
    const newer = makeNormalizedRecord({
      patientId: "PT-003",
      enrollmentDate: "2023-04-25",
      responseAssessment: "confirmed_response",
      lastVisitDate: "2024-03-15",
    });

    const result = deduplicateRecords([older, newer]);

    expect(result.deduped).toHaveLength(1);
    expect(result.deduped[0]!.normalized.responseAssessment).toBe("confirmed_response");
    expect(result.quarantinedDuplicates).toHaveLength(1);
    expect(result.quarantinedDuplicates[0]!.reasons).toContain("duplicate_record");
  });

  it("leaves unique records untouched", () => {
    const first = makeNormalizedRecord({ patientId: "PT-001" });
    const second = makeNormalizedRecord({ patientId: "PT-002", enrollmentDate: "2023-04-18" });

    const result = deduplicateRecords([first, second]);

    expect(result.deduped).toHaveLength(2);
    expect(result.quarantinedDuplicates).toHaveLength(0);
    expect(result.droppedDuplicates).toBe(0);
  });
});

describe("processRawCsv quarantine behavior", () => {
  const header =
    "patient_id,trial_id,site_id,enrollment_date,age,sex,weight_kg,dose_level,adverse_events,lab_notes,response_assessment,last_visit_date,status";

  it("quarantines implausible and missing clinical values", () => {
    const csv = [
      header,
      'PT-001,NCT-001,SITE-A01,2023-04-12,-3,M,82.3,400mg BID,"fatigue","note",partial_response,2024-01-15,active',
      'PT-002,NCT-001,SITE-A01,2023-04-12,,M,82.3,400mg BID,"fatigue","note",partial_response,2024-01-15,active',
      'PT-003,NCT-001,SITE-A01,2023-04-12,67,M,0,400mg BID,"fatigue","note",partial_response,2024-01-15,active',
    ].join("\n");

    const result = processRawCsv(csv);

    expect(result.summary.totalQuarantined).toBe(3);
    expect(result.quarantined[0]!.reasons).toContain("implausible_age");
    expect(result.quarantined[1]!.reasons).toContain("missing_age");
    expect(result.quarantined[2]!.reasons).toContain("implausible_weight");
  });

  it("drops rows with blank patient_id", () => {
    const csv = [
      header,
      ',NCT-003,SITE-D01,2024-06-01,57,F,63.5,200mg QD,"headache;fatigue","note",N/A,2024-06-01,screen_fail',
    ].join("\n");

    const result = processRawCsv(csv);

    expect(result.summary.totalInput).toBe(1);
    expect(result.summary.totalDropped).toBe(1);
    expect(result.summary.totalQuarantined).toBe(0);
    expect(result.summary.totalClean).toBe(0);
  });
});

describe("runPipeline integration", () => {
  const csvPath = fileURLToPath(
    new URL("../../data/incoming_patient_data.csv", import.meta.url)
  );

  it("produces the expected summary counts for the seeded CSV", async () => {
    const result = await runPipeline(csvPath);

    expect(result.summary.totalInput).toBe(51);
    expect(result.summary.totalDropped).toBe(1);
    expect(result.summary.totalQuarantined).toBe(5);
    expect(result.summary.totalClean).toBe(45);
    expect(
      result.summary.totalClean +
        result.summary.totalQuarantined +
        result.summary.totalDropped
    ).toBe(result.summary.totalInput);
  });

  it("keeps the latest PT-003 record and quarantines the older conflicting duplicate", async () => {
    const result = await runPipeline(csvPath);

    const pt003 = result.clean.find((record) => record.patientId === "PT-003");
    expect(pt003).toBeDefined();
    expect(pt003!.responseAssessment).toBe("confirmed_response");
    expect(pt003!.lastVisitDate).toBe("2024-03-15");

    const quarantinedDuplicate = result.quarantined.find(
      (entry) => entry.record["patient_id"] === "PT-003" && entry.reasons.includes("duplicate_record")
    );
    expect(quarantinedDuplicate).toBeDefined();
  });

  it("removes obvious PII and em dash artifacts from clean lab notes", async () => {
    const result = await runPipeline(csvPath);

    for (const record of result.clean) {
      expect(record.labNotes).not.toMatch(/4451892|412-XX-8891|@site-b03\.clinic/);
      expect(record.labNotes).not.toContain("Michael Chen");
      expect(record.labNotes).not.toContain("Rachel Kim");
      expect(record.labNotes).not.toContain("Lisa Park");
      expect(record.labNotes).not.toContain("—");
    }
  });
});