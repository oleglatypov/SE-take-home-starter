# Pathos — Senior Engineer Take-Home Exercise

Welcome, and thank you for investing time in our process.

This is not a greenfield build exercise. You will receive a **working codebase** — a small clinical trial data service that another engineer wrote. Your job is to find what's wrong with it, improve it, and make a hard architectural decision.

We explicitly permit and expect AI assistance. We use AI tools at Pathos every day. What we're evaluating is your **judgment, debugging process, and decision-making** — the things that remain distinctly human even when AI writes code faster than we can.

**Time budget:** ~6 hours  
**Window:** 5 calendar days from receipt  
**Submission:** Push your fork to a GitHub repo and send us the link (private is fine — invite `pathos-hiring`)

---

## Background

Pathos builds a pharmaceutical intelligence platform. The codebase you're receiving is a small service that:
- Ingests clinical trial data from CSV files
- Exposes it via a REST API with filtering, sorting, and search
- Provides a streaming AI-powered analysis endpoint using the Vercel AI SDK
- Includes a small test suite that passes

The server runs. The tests pass. **But the codebase has real problems** — the kind that cause incidents in production.

---

## Part 1 — Bug Hunt (find and fix)

The codebase contains **at least 5 bugs**. Some are subtle. Some are severe. None are syntax errors — the code compiles and the existing tests pass.

We planted bugs that mirror real issues we've encountered at Pathos: race conditions, data integrity problems, security gaps, type-safety holes, and performance traps.

**Your deliverables for Part 1:**

1. Create a file called `BUG_REPORT.md` in the project root. For each bug you find:
   - Describe the bug and how you discovered it
   - Explain the real-world impact (what would happen in production)
   - Show your fix (reference the file and line)
   - Explain why your fix is correct
   - If there was a tradeoff in how to fix it, explain the alternatives you considered

2. Fix the bugs in the code.

3. Write at least one test per bug that would have caught it. Add these to the test suite.

**We are evaluating:**
- How many bugs you find (there is no published total — find as many as you can)
- The quality of your explanations (do you understand *why* it's a bug, or just that it's wrong?)
- Whether your fixes are correct and minimal (don't rewrite the whole codebase)
- Whether your new tests actually target the specific failure mode

---

## Part 2 — Dirty Data Pipeline

The file `data/incoming_patient_data.csv` contains 50 rows of patient-level clinical data from a (fictional) external CRO partner. The data is messy — as real clinical data always is.

Build a pipeline that reads this CSV and produces a clean, validated, normalized dataset. The pipeline should be a function (or set of functions) that can be called programmatically — not a one-off script.

**The data has problems including (but not limited to):**
- Mixed date formats
- Missing required fields
- Values that are syntactically valid but clinically implausible
- Suspected PII in free-text fields
- Duplicate records with conflicting data
- Encoding artifacts

**For each category of data quality issue, you must decide how to handle it.** There is no single correct answer. Some options:
- Drop the row
- Flag it for human review (quarantine)
- Impute/correct the value with a documented rule
- Accept it as-is with a warning

**Your deliverables for Part 2:**

1. The pipeline code (in `src/services/data-pipeline.ts` or wherever you prefer).

2. A `DECISIONS.md` file (required, not optional) explaining:
   - Each category of data issue you found
   - What you decided to do about it and **why**
   - What alternative approaches you considered
   - Any assumptions you made about what the downstream consumer needs

3. At least 3 tests for your pipeline covering different edge cases.

4. The pipeline should output:
   - A clean dataset (array of validated records)
   - A quarantine list (records that need human review, with reasons)
   - A summary of what was cleaned, dropped, or quarantined

**We are evaluating:**
- The quality of your judgment calls (not whether you match our preferred answer — there is no preferred answer)
- How you handle ambiguity when the "right" thing to do isn't obvious
- Whether your pipeline is actually usable (typed inputs/outputs, error handling, testable)
- The clarity and reasoning in `DECISIONS.md`

---

## Part 3 — Architecture Decision Record

Read the file `ARCHITECTURE_PROMPT.md` (included in the starter). It describes two options for adding a "batch re-analysis" feature to this service. Both options are intentionally defensible.

Write a 1–2 page `ADR.md` (Architecture Decision Record) that:
1. States which option you'd choose
2. Argues for it with specific technical reasoning
3. Acknowledges the strongest argument for the option you *didn't* choose
4. Describes what would change your mind (under what conditions would the other option be better?)
5. Outlines a rough implementation plan (what would you build first, second, third?)

**We are evaluating:**
- The rigor of your technical reasoning (not which option you pick)
- Whether you engage honestly with the tradeoffs (not just cheerleading your choice)
- Your ability to think about a system that doesn't exist yet
- Whether your implementation plan is grounded and sequenced sensibly

---

## What We're Evaluating (Overall)

| Area | Weight | Source |
|---|---|---|
| Bug discovery and explanation | High | Part 1 |
| Quality of fixes and regression tests | High | Part 1 |
| Data quality judgment and pipeline design | High | Part 2 |
| Written reasoning (DECISIONS.md, BUG_REPORT.md) | High | Parts 1 & 2 |
| Architecture decision reasoning (ADR.md) | Medium | Part 3 |
| TypeScript quality across all code changes | Medium | All |
| Test design and coverage | Medium | Parts 1 & 2 |

**Notice:** Written reasoning is weighted as heavily as code. A perfect fix with no explanation scores lower than a good fix with a clear explanation.

---

## Setup

```bash
cd starter
npm install
cp .env.example .env   # add the API key we provided separately
npm run dev             # starts on :3000
npm test                # tests should pass (that's part of the problem)
```

---

## Submission Checklist

Before submitting, verify:

- [ ] `npm install && npm run dev` starts the server
- [ ] `npm test` passes (including your new tests)
- [ ] `BUG_REPORT.md` exists and documents each bug
- [ ] `DECISIONS.md` exists and documents your data pipeline choices
- [ ] `ADR.md` exists and argues for an architecture option
- [ ] Your code changes are in clean, reviewable commits (we read commit history)

---

## A Note on AI Assistance

You may use any AI tools you like — Claude, ChatGPT, Copilot, whatever helps you. We use them at Pathos daily.

But here's what AI is good at and what it isn't:
- AI can write code from a spec quickly. This exercise doesn't have a clear spec — it has ambiguity, messy data, and bugs hidden in context.
- AI can generate plausible-sounding explanations. We're looking for explanations that reveal you actually understood the *specific* problem in *this specific* code.
- AI can propose architectures. We're looking for reasoning that engages with tradeoffs specific to *this* system.

The best submissions we've seen use AI as an accelerator while bringing their own judgment, experience, and intellectual honesty.

---

## Questions?

Email [engineering@pathos.com] — we'll respond within 24 hours.
