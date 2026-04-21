import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PatientRecord, PipelineResult } from "../types.js";

export type RawRecord = Record<string, string>;

export type IssueKey =
  | "ambiguous_date"
  | "duplicate_record"
  | "encoding_artifact"
  | "implausible_age"
  | "implausible_weight"
  | "invalid_enrollment_date"
  | "invalid_last_visit_date"
  | "invalid_sex"
  | "invalid_status"
  | "missing_age"
  | "missing_adverse_events"
  | "missing_dose_level"
  | "missing_enrollment_date"
  | "missing_lab_notes"
  | "missing_last_visit_date"
  | "missing_patient_id"
  | "missing_sex"
  | "missing_site_id"
  | "missing_status"
  | "missing_trial_id"
  | "mixed_date_format"
  | "na_string_converted"
  | "pii_redacted"
  | "schema_validation_failure"
  | "sex_normalized"
  | "dose_encoding_inconsistency";

type NormalizedSex = PatientRecord["sex"] | null;
type NormalizedStatus = PatientRecord["status"] | null;

export interface NormalizedRecord {
  raw: RawRecord;
  normalized: {
    patientId: string;
    trialId: string;
    siteId: string;
    enrollmentDate: string;
    age: number | null;
    sex: NormalizedSex;
    weight: number | null;
    doseLevel: string;
    adverseEvents: string[];
    labNotes: string;
    responseAssessment: string | null;
    lastVisitDate: string;
    status: NormalizedStatus;
  };
  issues: IssueKey[];
  quarantineReasons: IssueKey[];
}

const PatientRecordSchema = z.object({
  patientId: z.string().min(1),
  trialId: z.string().min(1),
  siteId: z.string().min(1),
  enrollmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  age: z.number().int().min(0).max(120),
  sex: z.enum(["M", "F", "Other"]),
  weight: z.number().positive(),
  doseLevel: z.string().min(1),
  adverseEvents: z.array(z.string()),
  labNotes: z.string(),
  responseAssessment: z.string().nullable(),
  lastVisitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["active", "completed", "withdrawn", "screen_fail"]),
});

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b\d{3}-[X\d]{2}-\d{4}\b/gi, replacement: "[SSN REDACTED]" },
  {
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL REDACTED]",
  },
  { pattern: /\bMRN[:\s#]+\d{5,10}\b/gi, replacement: "[MRN REDACTED]" },
  {
    pattern: /\bPatient\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g,
    replacement: "Patient [NAME REDACTED]",
  },
  {
    pattern: /\bDr\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g,
    replacement: "Dr. [NAME REDACTED]",
  },
  {
    pattern: /\bCRA\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g,
    replacement: "CRA [NAME REDACTED]",
  },
];

function addIssue(list: IssueKey[], issue: IssueKey): void {
  if (!list.includes(issue)) {
    list.push(issue);
  }
}

function formatIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDelimitedRow(rowText: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < rowText.length; index++) {
    const char = rowText[index];
    const next = rowText[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char ?? "";
  }

  cells.push(current);
  return cells;
}

export function parseCsv(raw: string): RawRecord[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim() !== "");

  if (nonEmptyLines.length === 0) {
    return [];
  }

  const headers = parseDelimitedRow(nonEmptyLines[0] ?? "").map((header) => header.trim());
  const records: RawRecord[] = [];

  for (const line of nonEmptyLines.slice(1)) {
    const values = parseDelimitedRow(line);
    const record: RawRecord = {};

    for (let index = 0; index < headers.length; index++) {
      const header = headers[index];
      if (!header) {
        continue;
      }
      record[header] = values[index]?.trim() ?? "";
    }

    records.push(record);
  }

  return records;
}

export function parseDate(raw: string): { iso: string | null; ambiguous: boolean } | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoMatch) {
    return {
      iso: formatIso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])),
      ambiguous: false,
    };
  }

  const slashIsoMatch = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (slashIsoMatch) {
    return {
      iso: formatIso(
        Number(slashIsoMatch[1]),
        Number(slashIsoMatch[2]),
        Number(slashIsoMatch[3])
      ),
      ambiguous: false,
    };
  }

  const textMatch = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(value);
  if (textMatch) {
    const month = MONTHS[textMatch[1]!.toLowerCase()];
    if (!month) {
      return null;
    }
    return {
      iso: formatIso(Number(textMatch[3]), month, Number(textMatch[2])),
      ambiguous: false,
    };
  }

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!slashMatch) {
    return null;
  }

  const first = Number(slashMatch[1]);
  const second = Number(slashMatch[2]);
  const year = Number(slashMatch[3]);

  if (first <= 12 && second <= 12) {
    return { iso: null, ambiguous: true };
  }

  if (first > 12) {
    return { iso: formatIso(year, second, first), ambiguous: false };
  }

  return { iso: formatIso(year, first, second), ambiguous: false };
}

export function redactPii(text: string): { redacted: string; found: boolean } {
  let redacted = text;
  let found = false;

  for (const { pattern, replacement } of PII_PATTERNS) {
    const updated = redacted.replace(pattern, replacement);
    if (updated !== redacted) {
      found = true;
      redacted = updated;
    }
  }

  return { redacted, found };
}

export function normalizeEncodingArtifacts(text: string): {
  normalized: string;
  changed: boolean;
} {
  const normalized = text.replace(/[\u2013\u2014]/g, "-");
  return { normalized, changed: normalized !== text };
}

export function normalizeSex(raw: string): "M" | "F" | "Other" | null {
  const value = raw.trim().toLowerCase();
  if (value === "m" || value === "male") {
    return "M";
  }
  if (value === "f" || value === "female") {
    return "F";
  }
  if (value === "other") {
    return "Other";
  }
  return null;
}

export function parseAdverseEvents(raw: string): string[] {
  return raw
    .split(";")
    .map((event) => event.trim())
    .filter((event) => event !== "");
}

export function normalizeResponseAssessment(raw: string): string | null {
  const value = raw.trim();
  if (!value || /^n\/a$/i.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function normalizeDateField(
  raw: string,
  issues: IssueKey[],
  quarantineReasons: IssueKey[],
  missingIssue: IssueKey,
  invalidIssue: IssueKey
): string {
  if (!raw.trim()) {
    addIssue(issues, missingIssue);
    addIssue(quarantineReasons, missingIssue);
    return "";
  }

  const parsed = parseDate(raw);
  if (!parsed) {
    addIssue(issues, invalidIssue);
    addIssue(quarantineReasons, invalidIssue);
    return "";
  }

  if (parsed.ambiguous || !parsed.iso) {
    addIssue(issues, "ambiguous_date");
    addIssue(quarantineReasons, "ambiguous_date");
    return "";
  }

  if (parsed.iso !== raw.trim()) {
    addIssue(issues, "mixed_date_format");
  }

  return parsed.iso;
}

function normalizeRecord(raw: RawRecord): NormalizedRecord {
  const issues: IssueKey[] = [];
  const quarantineReasons: IssueKey[] = [];

  const trialId = raw["trial_id"]?.trim() ?? "";
  if (!trialId) {
    addIssue(issues, "missing_trial_id");
    addIssue(quarantineReasons, "missing_trial_id");
  }

  const siteId = raw["site_id"]?.trim() ?? "";
  if (!siteId) {
    addIssue(issues, "missing_site_id");
    addIssue(quarantineReasons, "missing_site_id");
  }

  const enrollmentDate = normalizeDateField(
    raw["enrollment_date"] ?? "",
    issues,
    quarantineReasons,
    "missing_enrollment_date",
    "invalid_enrollment_date"
  );

  const rawAge = raw["age"]?.trim() ?? "";
  let age: number | null = null;
  if (!rawAge) {
    addIssue(issues, "missing_age");
    addIssue(quarantineReasons, "missing_age");
  } else {
    const parsedAge = Number(rawAge);
    if (!Number.isFinite(parsedAge) || !Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 120) {
      addIssue(issues, "implausible_age");
      addIssue(quarantineReasons, "implausible_age");
    } else {
      age = parsedAge;
    }
  }

  const normalizedSex = normalizeSex(raw["sex"] ?? "");
  if (!(raw["sex"]?.trim())) {
    addIssue(issues, "missing_sex");
    addIssue(quarantineReasons, "missing_sex");
  } else if (!normalizedSex) {
    addIssue(issues, "invalid_sex");
    addIssue(quarantineReasons, "invalid_sex");
  } else if (normalizedSex !== raw["sex"]!.trim()) {
    addIssue(issues, "sex_normalized");
  }

  const rawWeight = raw["weight_kg"]?.trim() ?? "";
  const parsedWeight = Number(rawWeight);
  const weight = Number.isFinite(parsedWeight) ? parsedWeight : null;
  if (weight === null || weight <= 0) {
    addIssue(issues, "implausible_weight");
    addIssue(quarantineReasons, "implausible_weight");
  }

  const doseLevel = raw["dose_level"]?.trim() ?? "";
  if (!doseLevel) {
    addIssue(issues, "missing_dose_level");
    addIssue(quarantineReasons, "missing_dose_level");
  } else if (!/\d/.test(doseLevel)) {
    addIssue(issues, "dose_encoding_inconsistency");
  }

  const adverseEventsRaw = raw["adverse_events"] ?? "";
  const adverseEvents = parseAdverseEvents(adverseEventsRaw);
  if (adverseEvents.length === 0) {
    addIssue(issues, "missing_adverse_events");
  }

  const initialNotes = raw["lab_notes"]?.trim() ?? "";
  if (!initialNotes) {
    addIssue(issues, "missing_lab_notes");
  }
  const normalizedNotes = normalizeEncodingArtifacts(initialNotes);
  if (normalizedNotes.changed) {
    addIssue(issues, "encoding_artifact");
  }
  const redactedNotes = redactPii(normalizedNotes.normalized);
  if (redactedNotes.found) {
    addIssue(issues, "pii_redacted");
  }

  const responseAssessmentRaw = raw["response_assessment"] ?? "";
  const responseAssessment = normalizeResponseAssessment(responseAssessmentRaw);
  if (/^n\/a$/i.test(responseAssessmentRaw.trim())) {
    addIssue(issues, "na_string_converted");
  }

  const lastVisitDate = normalizeDateField(
    raw["last_visit_date"] ?? "",
    issues,
    quarantineReasons,
    "missing_last_visit_date",
    "invalid_last_visit_date"
  );

  const statusValue = raw["status"]?.trim() ?? "";
  let status: NormalizedStatus = null;
  if (!statusValue) {
    addIssue(issues, "missing_status");
    addIssue(quarantineReasons, "missing_status");
  } else if (
    statusValue === "active" ||
    statusValue === "completed" ||
    statusValue === "withdrawn" ||
    statusValue === "screen_fail"
  ) {
    status = statusValue;
  } else {
    addIssue(issues, "invalid_status");
    addIssue(quarantineReasons, "invalid_status");
  }

  return {
    raw,
    normalized: {
      patientId: raw["patient_id"]?.trim() ?? "",
      trialId,
      siteId,
      enrollmentDate,
      age,
      sex: normalizedSex,
      weight,
      doseLevel,
      adverseEvents,
      labNotes: redactedNotes.redacted,
      responseAssessment,
      lastVisitDate,
      status,
    },
    issues,
    quarantineReasons,
  };
}

function recordsEqual(left: NormalizedRecord, right: NormalizedRecord): boolean {
  return JSON.stringify(left.normalized) === JSON.stringify(right.normalized);
}

export function deduplicateRecords(records: NormalizedRecord[]): {
  deduped: NormalizedRecord[];
  quarantinedDuplicates: Array<{ record: NormalizedRecord; reasons: string[] }>;
  droppedDuplicates: number;
} {
  const groups = new Map<string, NormalizedRecord[]>();

  for (const record of records) {
    const key = [
      record.normalized.patientId,
      record.normalized.trialId,
      record.normalized.siteId,
      record.normalized.enrollmentDate,
    ].join("::");

    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  const deduped: NormalizedRecord[] = [];
  const quarantinedDuplicates: Array<{ record: NormalizedRecord; reasons: string[] }> = [];
  let droppedDuplicates = 0;

  for (const group of groups.values()) {
    if (group.length === 1) {
      deduped.push(group[0]!);
      continue;
    }

    const sorted = [...group].sort((left, right) =>
      right.normalized.lastVisitDate.localeCompare(left.normalized.lastVisitDate)
    );
    const canonical = sorted[0]!;
    deduped.push(canonical);

    for (const record of sorted.slice(1)) {
      addIssue(record.issues, "duplicate_record");
      if (recordsEqual(record, canonical)) {
        droppedDuplicates++;
        continue;
      }

      addIssue(record.quarantineReasons, "duplicate_record");
      quarantinedDuplicates.push({
        record,
        reasons: [...record.quarantineReasons],
      });
    }
  }

  return { deduped, quarantinedDuplicates, droppedDuplicates };
}

function incrementIssueCounts(target: Record<string, number>, issues: IssueKey[]): void {
  for (const issue of issues) {
    target[issue] = (target[issue] ?? 0) + 1;
  }
}

export function processRawCsv(csvText: string): PipelineResult {
  const rawRecords = parseCsv(csvText);
  const normalizedRecords: NormalizedRecord[] = [];
  const clean: PatientRecord[] = [];
  const quarantined: PipelineResult["quarantined"] = [];
  const issuesFound: Record<string, number> = {};
  let totalDropped = 0;

  for (const rawRecord of rawRecords) {
    const patientId = rawRecord["patient_id"]?.trim() ?? "";
    if (!patientId) {
      totalDropped++;
      incrementIssueCounts(issuesFound, ["missing_patient_id"]);
      continue;
    }

    normalizedRecords.push(normalizeRecord(rawRecord));
  }

  const { deduped, quarantinedDuplicates, droppedDuplicates } = deduplicateRecords(normalizedRecords);
  totalDropped += droppedDuplicates;
  if (droppedDuplicates > 0) {
    issuesFound["duplicate_record"] = (issuesFound["duplicate_record"] ?? 0) + droppedDuplicates;
  }

  for (const duplicate of quarantinedDuplicates) {
    incrementIssueCounts(issuesFound, duplicate.record.issues);
    quarantined.push({ record: duplicate.record.raw, reasons: duplicate.reasons });
  }

  for (const record of deduped) {
    if (record.quarantineReasons.length > 0) {
      incrementIssueCounts(issuesFound, record.issues);
      quarantined.push({ record: record.raw, reasons: [...record.quarantineReasons] });
      continue;
    }

    const parsed = PatientRecordSchema.safeParse(record.normalized);
    if (!parsed.success) {
      addIssue(record.issues, "schema_validation_failure");
      incrementIssueCounts(issuesFound, record.issues);
      quarantined.push({
        record: record.raw,
        reasons: ["schema_validation_failure"],
      });
      continue;
    }

    incrementIssueCounts(issuesFound, record.issues);
    clean.push(parsed.data);
  }

  return {
    clean,
    quarantined,
    summary: {
      totalInput: rawRecords.length,
      totalClean: clean.length,
      totalQuarantined: quarantined.length,
      totalDropped,
      issuesFound,
    },
  };
}

export async function runPipeline(csvPath: string): Promise<PipelineResult> {
  const csvText = await readFile(csvPath, "utf8");
  return processRawCsv(csvText);
}

