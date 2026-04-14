# Notes on `trial-service.ts`

## General Assessment

`starter/src/services/trial-service.ts` is acceptable for a tiny in-memory dataset, but it is not a good long-term shape for a growing service. The file mixes storage, indexing, filtering, searching, and sorting in one place, which makes it hard to reason about performance and correctness.

The biggest issue is not the `Map` itself. Building `trialCache` is a one-time `O(n)` startup cost and is reasonable if the service needs fast lookup by ID. The real bottleneck is the `listTrials` path, which re-scans the full dataset on every request, performs multiple string operations per record, and then sorts the full filtered result in memory.

## What Becomes Slow When `trialData` Gets Large

If `trialData` grows significantly, the bottlenecks are:

1. Full-array scans for every filter in `listTrials`.
2. Case-normalization and substring checks across several text fields for search.
3. In-memory sorting of all matching trials before returning results.
4. Returning the entire result set instead of paginating.

The `Map` is usually not the performance problem. It duplicates references in memory, but that cost is typically much smaller than repeated filtering and sorting work on every request.

## What I Don't Like About the Current Design

1. It uses global module-level state (`trialData` plus `trialCache`), which makes future updates and testing more brittle.
2. It mixes repository concerns with query logic instead of separating data access from query behavior.
3. It gives the impression of a scalable query API, but everything is evaluated in memory.
4. The current search implementation is especially fragile and already contains correctness issues.

## Practical Recommendation

For the current starter dataset, keeping a `Map` for `getTrialById` is fine. The bigger improvements should focus on the list path:

1. Keep `getTrialById` indexed.
2. Clean up search logic so it does not mutate records and matches text correctly.
3. Add pagination to avoid returning and sorting the full result set every time.
4. Split the file into a cleaner repository/query boundary.
5. Move filtering, sorting, and search into a database layer once the dataset is no longer trivially small.

## Bottom Line

If this code were in production, I would not worry first about the cost of creating the `Map`. I would worry about the repeated in-memory filtering and sorting in `listTrials`, because that is the real scaling bottleneck.

---

# CSV Validation: `incoming_patient_data.csv`

**50 data rows, 13 columns.** Issues found across 18 rows.

## 1. Date Format Inconsistency — 4 formats in one file

The pipeline must detect and handle all four before parsing any date:

| Patient | Field | Value | Format |
|---|---|---|---|
| PT-003 | enrollment_date | `04/25/2023` | MM/DD/YYYY |
| PT-003 | last_visit_date | `01/22/2024` | MM/DD/YYYY |
| PT-009 | enrollment_date | `Jun 20 2023` | Mon DD YYYY |
| PT-009 | last_visit_date | `Mar 15 2024` | Mon DD YYYY |
| PT-019 | enrollment_date | `2023/11/01` | YYYY/MM/DD (slash, not ISO dash) |
| PT-028 | enrollment_date | `15/05/2024` | DD/MM/YYYY |

**Specific ambiguity — PT-003 and PT-028 slash formats use opposite conventions:**

- `04/25/2023` can only be MM/DD/YYYY (no 25th month exists)
- `15/05/2024` can only be DD/MM/YYYY (no 15th month exists)

Both use slashes but with different field ordering. A parser that assumes a single rule for all slashed dates will misparse one of them. The only safe resolution is to check whether the first or second segment exceeds 12 to determine which convention applies.

## 2. Impossible / Out-of-Range Values

| Patient | Field | Value | Problem |
|---|---|---|---|
| PT-004 | age | `-3` | Negative — biologically impossible |
| PT-014 | weight_kg | `0` | Zero weight — clinically invalid |
| PT-016 | age | `155` | No human lives to 155 |

All three must be quarantined. Imputation is not appropriate — a negative or implausibly high age cannot be corrected without knowing the true value.

## 3. Missing Required Fields

| Patient | Field | Problem |
|---|---|---|
| *(row 31, blank)* | patient_id | Primary key is absent — record cannot be identified or deduplicated. **Drop.** |
| PT-011 | age | Empty string where a number is required. Quarantine or impute with cohort median. |

The row with no `patient_id` is the one record that should be dropped outright rather than quarantined — there is no key to resolve against or report on.

## 4. Duplicate Record with Conflicting Data

**PT-003** appears on rows 4 and 17 — same `patient_id`, `trial_id`, `site_id`, `enrollment_date`, `age`, `sex`, `weight_kg`, `dose_level`.

| Field | Row 4 (original) | Row 17 (amendment) |
|---|---|---|
| response_assessment | `partial_response` | `confirmed_response` |
| last_visit_date | `01/22/2024` | `03/15/2024` |
| lab_notes | `PSA 8.1 ng/mL, significant decline (-62%)` | same + `UPDATE: confirmed PR by RECIST` |

Row 17 is clearly a later amendment: later visit date, upgraded response classification, explicit `UPDATE:` prefix in notes. The pipeline decision: keep row 17 as authoritative, quarantine row 4 with reason `superseded_by_update`.

## 5. PII in `lab_notes` — HIPAA/GDPR Violation

| Patient | PII found | Severity |
|---|---|---|
| PT-004 | `Patient John Williams (MRN: 4451892)` — patient name + medical record number | Critical |
| PT-017 | `sarah.johnson@site-b03.clinic` — site staff email address | High |
| PT-037 | `Patient SSN visible in old system: 412-XX-8891` — partial Social Security Number | Critical |
| PT-050 | `Note from CRA Lisa Park: data query resolved` — staff full name | Low |

PT-004, PT-017, and PT-037 contain unambiguous regulatory violations. The pipeline must redact these fields before any downstream storage or processing, regardless of whether the record itself is otherwise clean. PT-050 (staff name only) is lower-risk but should still be redacted for consistency.

## 6. Sex Field Value Inconsistency

**PT-040** has `sex = "Male"`. All other records use `"M"`, `"F"`, or `"Other"`, which matches the `PatientRecord.sex` type definition (`"M" | "F" | "Other"`). `"Male"` does not match any valid enum value. The intent is unambiguous — normalize to `"M"` on ingest.

## 7. Protocol / Enrollment Integrity Issues

**PT-006 — Wrong sex enrolled in a male-only trial:**
NCT-001 (AURORA-1) studies metastatic castration-resistant prostate cancer, which is biologically restricted to males. PT-006 is coded `F`. The `lab_notes` field reads: `"PSA not applicable (female patient enrolled in error?)"`. The record is already `screen_fail`, but the question mark in the notes indicates the site was uncertain whether this was a data entry error or an actual enrollment error. Quarantine with reason `protocol_violation_sex_mismatch`.

**PT-045 — Active patient in a completed trial:**
PT-045 is enrolled in NCT-002 (BEACON-3), whose `status` in `data.ts` is `"completed"`. The patient record `status` is `"active"`. A completed trial cannot have active patients. Flag for manual reconciliation — this may be a data entry error or a trial status lag.

## 8. Dose Cohort Variations (informational)

| Patient | dose_level | Note |
|---|---|---|
| PT-013 | `200mg BID` | NCT-001 standard arm is `400mg BID`. Lab notes confirm: "dose escalation cohort." Valid — preserve and flag in summary. |
| PT-037 | `600mg BID` | DLT declared at this dose; patient withdrawn. Clinically significant — must be preserved in the pipeline output, not dropped. |

These are not errors. PT-013 represents a legitimate sub-cohort. PT-037 documents a DLT event that is critical safety information.

## 9. Disposition Summary

| Category | Rows affected | Decision |
|---|---|---|
| Date format variants (4 formats) | PT-003, PT-009, PT-019, PT-028 | **Clean** — normalize all to ISO 8601 |
| Impossible age values | PT-004, PT-016 | **Quarantine** |
| Zero weight | PT-014 | **Quarantine** |
| Missing age | PT-011 | **Quarantine** (or impute median with explicit justification) |
| Missing patient_id | row 31 | **Drop** — no key to resolve against |
| Duplicate with conflict | PT-003 rows 4 & 17 | **Keep row 17, quarantine row 4** as `superseded_by_update` |
| PII in lab_notes | PT-004, PT-017, PT-037, PT-050 | **Redact** before clean or quarantine output |
| Sex value mismatch | PT-040 | **Clean** — normalize `"Male"` → `"M"` |
| Protocol violation (sex/trial) | PT-006 | **Quarantine** as `protocol_violation_sex_mismatch` |
| Active patient in completed trial | PT-045 | **Flag** for manual reconciliation |

**Estimated totals after pipeline:**
- Clean: ~40 records
- Quarantined: ~7 records
- Dropped: 1 record (no patient_id)

---

# API Endpoints

Base URL:

```bash
http://localhost:3000
```

## 1. Health Check

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok"}
```

## 2. List All Trials

```bash
curl http://localhost:3000/trials
```

## 3. List Trials With Filters

Supported query params:

- `phase`
- `status`
- `minEnrollment`
- `sponsor`
- `search`
- `sort`
- `order`

Example:

```bash
curl "http://localhost:3000/trials?phase=III&status=completed&minEnrollment=400&sort=enrollment&order=asc"
```

Search example:

```bash
curl "http://localhost:3000/trials?search=melanoma&sponsor=genentech"
```

## 4. Get Trial By ID

```bash
curl http://localhost:3000/trials/NCT-001
```

Not found example:

```bash
curl http://localhost:3000/trials/NCT-999
```

## 5. Get Trial Summary

```bash
curl http://localhost:3000/trials/NCT-001/summary
```

## 6. Stream AI Analysis For A Trial

This endpoint is `POST` and expects a JSON body with `focus`.

Safety:

```bash
curl -N \
	-X POST http://localhost:3000/trials/NCT-001/analyze \
	-H "Content-Type: application/json" \
	-d '{"focus":"safety"}'
```

Efficacy:

```bash
curl -N \
	-X POST http://localhost:3000/trials/NCT-001/analyze \
	-H "Content-Type: application/json" \
	-d '{"focus":"efficacy"}'
```

Competitive:

```bash
curl -N \
	-X POST http://localhost:3000/trials/NCT-001/analyze \
	-H "Content-Type: application/json" \
	-d '{"focus":"competitive"}'
```

Notes:

- Use `-N` because the response is streamed as Server-Sent Events.
- This endpoint requires `OPENAI_API_KEY` in the environment.
