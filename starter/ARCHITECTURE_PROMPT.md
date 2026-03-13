# Architecture Decision: Batch Re-Analysis

## Context

Pathos analysts occasionally need to re-analyze all trials in the system when a new competitive landscape report is published or when analysis criteria change. Currently, the `/trials/:id/analyze` endpoint handles one trial at a time, streaming the result back to the client.

We need to add a **batch re-analysis** capability that re-runs AI analysis across all trials (or a filtered subset) and stores the results. The system currently has 8 trials but will scale to ~500 within 6 months, and we expect the full batch to be triggered 2–3 times per week.

Each individual analysis takes 15–45 seconds depending on model load and trial complexity. The results must be stored (not just streamed) so analysts can review and compare them later.

## Constraints

- We use OpenAI's API with a rate limit of 500 requests/minute and a budget of ~$200/month for analysis
- The service runs on a single Node.js process (no worker fleet)
- We need to preserve the streaming single-trial endpoint — analysts still use it for ad-hoc queries
- The UI team wants real-time progress updates ("Analyzing trial 42 of 187...")
- If an individual trial analysis fails (AI error, timeout), the batch should continue with the remaining trials
- Results should be queryable: "show me all trials where the safety analysis flagged high risk"

## Option A — In-Process Queue with Database-Backed State

Run the batch entirely within the existing Node.js process using an in-memory priority queue. Each analysis job is written to a `batch_jobs` database table before execution. A background loop pulls jobs from the queue and processes them sequentially (or with limited concurrency, e.g., 5 at a time).

**How it works:**
1. `POST /batch/analyze` creates a batch record in the DB, enqueues all trial IDs, returns a batch ID immediately
2. A `setInterval` loop (or `setTimeout` chain) processes the queue, updating each job's status in the DB as it completes
3. `GET /batch/:id/progress` reads progress from the DB (or from an in-memory counter with DB fallback)
4. Results are stored in an `analysis_results` table with the batch ID, trial ID, focus, and full AI output
5. If the process crashes mid-batch, on restart it reads incomplete jobs from the DB and re-enqueues them

**Strengths of this approach:**
- No new infrastructure — everything runs in the existing process
- Simple to implement and debug
- DB-backed state means we can recover from crashes
- Low operational overhead — no queue service to maintain

**Weaknesses of this approach:**
- The batch competes with ad-hoc requests for the same Node.js event loop
- In-memory queue is lost on crash (though DB allows recovery, the queue state must be rebuilt)
- Single-process concurrency is limited — 5 concurrent AI calls may be all we can do without starving the API
- Scaling beyond ~200 trials per batch will push against Node.js memory and concurrency limits

---

## Option B — External Job Queue with Separate Worker

Introduce a lightweight external job queue (e.g., BullMQ with Redis, or pg-boss using the existing Postgres) and split the system into two processes: the API server and a worker process.

**How it works:**
1. `POST /batch/analyze` enqueues jobs into the external queue, each with a trial ID and focus. Returns a batch ID.
2. A separate worker process (same codebase, different entry point) pulls jobs from the queue and executes them. It can run 10+ concurrent AI calls without affecting the API.
3. Progress is tracked via the queue's built-in job status. The API reads queue state to serve `GET /batch/:id/progress`.
4. Results are stored in the same `analysis_results` table.
5. Crash recovery is handled by the queue system (BullMQ retries failed jobs automatically).

**Strengths of this approach:**
- Clean separation — batch work can't starve the API
- Better concurrency model — worker can be tuned independently
- Queue system handles retries, dead letters, and backpressure natively
- Can scale horizontally by adding more workers later

**Weaknesses of this approach:**
- Adds infrastructure (Redis or more complex pg-boss setup)
- Two processes to deploy, monitor, and debug
- More moving parts — queue connection failures, worker health checks, message serialization
- For our current scale (~500 trials, 2–3 batches/week), this may be over-engineered

---

## Your Task

Write an Architecture Decision Record (`ADR.md`) choosing one of these options. See the candidate README for what the ADR should contain.

Neither option is "correct." We've had real debates about this exact decision at Pathos. We're evaluating the quality of your reasoning, not which option you pick.
