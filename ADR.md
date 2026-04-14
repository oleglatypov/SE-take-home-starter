# ADR: Batch Re-Analysis Architecture

**Status:** Proposed  
**Date:** 2026-04-14  
**Decision:** Option A - In-Process Queue with Database-Backed State

---

## Context

Pathos needs a batch re-analysis feature that can re-run AI analysis across all trials, or a filtered subset, and store the results for later review. The current service is still simple: one Node.js API process, trial data in memory, and a single-trial analysis endpoint that streams results over SSE instead of saving them.

The batch workload is meaningful but not huge. We expect up to about 500 trials within six months, with a full re-analysis triggered 2-3 times per week. Each analysis takes 15-45 seconds. The UI wants progress updates while the batch runs. Individual trial failures should not stop the rest of the batch. The outputs also need to be queryable later.

There is one more practical constraint: the current codebase does not appear to have a persistence layer for analysis results yet. So both options require adding durable storage. The real decision is whether to stop at durable storage plus an in-process scheduler, or introduce a separate worker and queue right now.

---

## Decision

Choose **Option A: an in-process queue with database-backed state**.

That is the right next step for this service. The immediate gap is durable batch state, not distributed job execution. Option A gives us stored results, resumability, and progress tracking without forcing us to add a second process and queue infrastructure at the same time.

---

## Why This Option

Option A fits the system we actually have. Analysis already runs inside one API process. The next sensible move is to add durable state around that flow, not jump straight to a two-process architecture before we even have stored results.

The expected workload also fits within a bounded in-process model. With concurrency capped around 3-5, a 500-trial batch is slow but acceptable for something that runs only a few times per week. We are not close to the stated OpenAI rate limit at that level. Just as important, this work is mostly waiting on external I/O, not burning CPU locally.

The throughput math supports that. At 5 concurrent analyses and a 30-second average runtime, a 500-trial batch takes about `(500 / 5) * 30 = 3,000` seconds, or roughly 50 minutes. At a slower 45-second average, the same batch takes about 75 minutes. Even with a more conservative cap of 3 concurrent analyses at 45 seconds each, total runtime is about `(500 / 3) * 45 = 7,500` seconds, or just over 2 hours. For a job that runs 2-3 times per week, that is still workable.

The rate-limit math is also comfortable. At 5 concurrent jobs with a 30-second average, we are issuing about 10 analysis requests per minute. At 10 concurrent jobs, we would still be around 20 requests per minute. That is far below the stated OpenAI cap of 500 requests per minute, so the near-term constraint is more likely spend, recovery complexity, or API interference than vendor rate limiting.

That does not mean Option A is free of contention. Batch work would still share a runtime with ad-hoc traffic, OpenAI calls, and any future database connections. That is a real cost. I am choosing Option A anyway because the batch frequency is low, the concurrency can be kept modest, and the operational cost of adding worker infrastructure now is higher than the benefit we get from it today.

Put differently: solve the missing durability problem first. Do not pay for full worker isolation until the system gives us evidence that we need it.

---

## Strongest Case for Option B

The strongest case for Option B is simple: it is cleaner.

Batch work would run outside the API process, which protects interactive traffic from long-running background analysis. That matters here because the current service already keeps SSE analysis requests open for a long time. If batch jobs and analyst traffic share one process, they will eventually compete with each other.

Option B is also better on recovery semantics. The hardest part of Option A is not holding jobs in memory. The hard part is restarting safely after a crash without losing work or double-processing trials whose results may already have been partially written. A real queue system gives a better foundation for retries, job ownership, and dead-letter handling.

If I were designing for the likely long-term shape of the platform rather than the best immediate move, I would pick Option B.

---

## What Would Change My Mind

I would switch to Option B if any of these become true:

1. We run multiple API instances behind a load balancer.
2. Batch completion time becomes a real product SLA, for example under 15-20 minutes. Finishing 500 trials in 15 minutes would mean starting about `500 / 15 ≈ 33` analyses per minute, which is a much stronger case for worker isolation and tighter concurrency control.
3. Daytime batch runs start hurting analyst workflows or the existing streaming analysis endpoint.
4. We add a second background job type, such as reporting, imports, or notifications.
5. Redis or another queue substrate is already part of the stack, so the infrastructure cost is mostly sunk.

---

## Rough Implementation Plan

### First: separate reusable analysis execution from HTTP streaming

Do this first. The queue is not the first problem.

Refactor the analysis service so the AI call can return a complete result without depending on an open HTTP response. Right now the code is built around streaming tokens back to the client. Batch execution needs the same analysis logic in a reusable form. Keep the existing single-trial SSE endpoint, but turn it into a thin transport adapter over that shared analysis primitive.

Add regression tests for the current streaming endpoint in this phase. It already exists in production shape, and this refactor is the easiest place to introduce a regression.

### Second: add durable state for batches and results

Next, add persistence for `batch_runs` and `analysis_results`, plus the minimal API surface to create a batch and read its status. If the codebase still has no database layer at that point, start with a small prerequisite phase to add a database client and migrations.

Store per-trial status, focus, full output text, timestamps, and error details. Also store whatever structured flags are needed to support the later query use case.

### Third: add the in-process scheduler with bounded concurrency

Only after analysis execution and persistence are in place should we add the scheduler.

Run a small number of jobs concurrently. Persist success or failure per trial so the batch can keep going when one analysis fails. On startup, reconcile in-flight jobs against persisted results, mark jobs with durable output as complete, and only requeue jobs that have no stored result. This recovery path is the hardest part of Option A, so build it deliberately.

After the core batch path is stable, add UI progress reporting. Start with a polling endpoint. Add SSE later only if the UI genuinely needs live updates.

---

## Summary

Choose Option A now.

It solves the immediate problem, stored and resumable batch analysis, without forcing a bigger architecture jump than this service currently needs. The tradeoff is real: recovery and isolation are weaker than they would be with a dedicated worker system. That is acceptable for the current workload, but it should be revisited if batch execution starts to stress interactive traffic or the service grows beyond a single-instance model.
