# Dirty Data Decisions

## Context

The incoming patient CSV is a CRO-style exchange file, not a canonical source of truth. The downstream consumer for this pipeline is an analytics workflow that needs a usable typed dataset for programmatic processing, but it also needs explicit visibility into records that should not be silently trusted.

That drove three rules:

1. Normalize when the correction is obvious and low-risk.
2. Quarantine when the record is still useful but not safe to trust automatically.
3. Drop only when the row cannot be meaningfully referenced downstream.

## Assumptions

- The downstream consumer prefers a clean, typed array of records over preserving raw source quirks.
- A quarantine list is acceptable for manual review and audit follow-up.
- The pipeline is a library function, so deterministic behavior matters more than interactive convenience.
- The CSV format is small enough that a manual parser is acceptable for now.

## Pipeline Structure

The pipeline is organized as a small sequence of pure transformation steps plus one file-loading wrapper:

1. Parse raw CSV rows into `Record<string, string>` objects.
2. Normalize individual fields: dates, categories, free text, and nullable values.
3. Flag invalid or suspicious records for quarantine while preserving issue reasons.
4. Deduplicate records by patient/trial/site/enrollment key, keeping the newest conflicting record.
5. Schema-validate clean records and return `{ clean, quarantined, summary }`.

The public entry points are:

- `processRawCsv(csvText: string)` for programmatic use with already-loaded CSV content.
- `runPipeline(csvPath: string)` for file-based use.

## How To Use

Typical file-based usage:

```typescript
import { runPipeline } from "./src/services/data-pipeline.js";

const result = await runPipeline("./data/incoming_patient_data.csv");

console.log(result.clean);
console.log(result.quarantined);
console.log(result.summary);
```

Return shape:

- `clean`: validated `PatientRecord[]`
- `quarantined`: raw source rows plus reason codes
- `summary`: total input, clean, quarantined, dropped, and issue counts

## Issue Categories

### Mixed date formats

Found:
- `YYYY-MM-DD`
- `YYYY/MM/DD`
- `Mon DD YYYY`
- `MM/DD/YYYY`
- one unambiguous `DD/MM/YYYY` record (`15/05/2024`)

Decision:
- Normalize known formats to ISO `YYYY-MM-DD`.
- Quarantine ambiguous slash dates where both date segments are `<= 12`.

Why:
- Date normalization is high value and low risk when the format is unambiguous.
- Ambiguous locale guessing would silently corrupt data.

Alternatives considered:
- Keep raw dates and push ambiguity downstream. Rejected because the pipeline output would not be normalized.
- Assume all slash dates are US format. Rejected because it would mis-handle the clearly non-US row.

### Missing required identifiers

Found:
- one row with blank `patient_id`

Decision:
- Drop the row.

Why:
- Without a stable identifier, the record cannot be joined, deduplicated, or safely quarantined for later reuse.

Alternatives considered:
- Quarantine it. Rejected because the missing identifier is exactly what prevents meaningful downstream handling.

### Missing required clinical fields

Found:
- blank age

Decision:
- Quarantine the row.

Why:
- Age is clinically meaningful, but the rest of the row is still potentially useful for manual review.

Alternatives considered:
- Drop it. Rejected because the row still contains enough context for follow-up.
- Impute age. Rejected because no trustworthy imputation rule exists here.

### Clinically implausible values

Found:
- age `-3`
- age `155`
- weight `0`

Decision:
- Quarantine the row.

Why:
- These values are medically implausible and likely data-entry errors.
- Silent correction would invent clinical facts.

Alternatives considered:
- Clamp or coerce values into a valid range. Rejected because it hides serious source-data defects.
- Drop the rows. Rejected because they remain reviewable and could be corrected manually.

### Suspected PII in free text

Found:
- MRN
- email address
- SSN fragment
- named patient, clinician, and CRA references

Decision:
- Redact obvious patterns in `lab_notes` and keep the record.

Why:
- The clinical content of the row is still useful.
- The PII is incidental contamination rather than the core payload.

Alternatives considered:
- Quarantine every row containing PII. Rejected because it would unnecessarily remove valid clinical data from the clean dataset.
- Leave PII as-is. Rejected because the pipeline should not preserve known identifiers in normalized output.

### Duplicate records with conflicting data

Found:
- `PT-003` appears twice with the same identity fields but different `response_assessment`, `last_visit_date`, and updated notes.

Decision:
- Keep the record with the newest normalized `lastVisitDate`.
- Quarantine the older conflicting row with a duplicate reason.

Why:
- The newer row reads like a legitimate update rather than a separate patient event.
- Quarantining the older version preserves an audit trail instead of silently deleting evidence of the conflict.

Alternatives considered:
- Drop the older row silently. Rejected because it hides that a conflict existed.
- Quarantine both rows. Rejected because it would throw away a clearly better canonical record.

### Categorical encoding issues

Found:
- `response_assessment = "N/A"`
- `sex = "Male"`

Decision:
- Convert `N/A` to `null`.
- Normalize `Male` to `M`.

Why:
- Both transformations are unambiguous and align with the downstream typed model.

Alternatives considered:
- Preserve the original strings. Rejected because that would leak source-specific encoding noise into the normalized dataset.

### Encoding artifacts

Found:
- em dash characters in notes

Decision:
- Normalize em dash and en dash characters to ASCII `-`.

Why:
- This is a low-risk normalization that improves downstream compatibility.

Alternatives considered:
- Preserve the original characters. Rejected because the pipeline’s purpose is normalized output, and ASCII compatibility is valuable for analytics exports.

### Missing optional fields

Found:
- empty `adverse_events`
- empty `lab_notes`

Decision:
- Normalize empty `adverse_events` to `[]`.
- Keep empty `lab_notes` as `""`.
- Count both in the summary, but do not quarantine.

Why:
- These fields are still structurally usable after normalization.

Alternatives considered:
- Quarantine all missing optional fields. Rejected because it is too strict for a dataset meant to remain usable.

### Dose encoding inconsistency

Found:
- NCT-002 rows use regimen text such as `vemurafenib + cobimetinib` instead of numeric dose strings.

Decision:
- Keep the value as-is and flag it as `dose_encoding_inconsistency`.

Why:
- The value is internally meaningful within that trial, but there is no safe transform to a numeric dose without external context.

Alternatives considered:
- Drop or quarantine the rows. Rejected because the regimen text is still useful.
- Attempt to map regimen names to numeric doses. Rejected because the CSV does not provide enough context to do that safely.

## Downstream Consumer Needs

The clean dataset is optimized for typed programmatic use. That means:

- dates should already be normalized
- categories should already be canonicalized
- free text should already be scrubbed of obvious identifiers
- clinically suspect records should not silently mix with trusted rows

The quarantine list exists to preserve recoverable business value without forcing unsafe records into the clean dataset.