# Bug Report

## Bug 1: `TrialFilters` interface incompatible with `exactOptionalPropertyTypes`

### Description

With `exactOptionalPropertyTypes: true` enabled in `tsconfig.json`, the `TrialFilters` interface in `trial-service.ts` declares optional properties (e.g., `phase?: string`), which means the properties can be *omitted* but cannot be explicitly set to `undefined`. However, the call site in `trials.ts` (line 17–25) destructures query parameters and passes them as `string | undefined`, which includes explicit `undefined` values when a query parameter is absent. This creates a type mismatch:

```
Type 'string | undefined' is not assignable to type 'string'.
```

I discovered this by running `npx tsc --noEmit`, which surfaced the TS2379 error on `trials.ts` line 17.

### Real-World Impact

In production, `tsc --noEmit` (or any CI type-check step) would fail, blocking builds and deployments. While the code still runs at runtime via `tsx` (which skips type checking), the project cannot be compiled cleanly. This undermines the entire purpose of strict TypeScript configuration — the strictness flag is set but the code violates it, meaning the team either can't use `tsc` in CI or has to ignore the errors, eroding type-safety guarantees.

### Fix

**File:** `starter/src/services/trial-service.ts`, lines 4–12

Change the `TrialFilters` interface to explicitly include `undefined` in each optional property's type:

```typescript
interface TrialFilters {
  phase?: string | undefined;
  status?: string | undefined;
  minEnrollment?: number | undefined;
  sponsor?: string | undefined;
  search?: string | undefined;
  sort?: string | undefined;
  order?: string | undefined;
}
```

### Why This Fix Is Correct

With `exactOptionalPropertyTypes: true`, TypeScript distinguishes between "property is missing" (`{ }`) and "property is explicitly `undefined`" (`{ phase: undefined }`). Writing `phase?: string` only allows omission. Writing `phase?: string | undefined` explicitly allows both omission and an explicit `undefined` value, which is exactly what happens when Express query parameters are absent and cast via `as string | undefined`.

### Alternatives Considered

1. **Filter out `undefined` values at the call site** — build the object conditionally, only including properties that are defined. This would keep the stricter interface but adds verbosity and complexity to the route handler for no real benefit.
2. **Disable `exactOptionalPropertyTypes`** — this would suppress the error globally but weakens the type system for the entire project. Not recommended since the flag catches real bugs elsewhere.
3. **Use a builder/validation layer (e.g., Zod)** — parse and validate query params before passing to `listTrials`. More robust long-term but over-engineered for this specific fix.

Option 1 is the cleanest alternative; I chose the interface change because it's minimal, correct, and idiomatic for codebases that enable `exactOptionalPropertyTypes`.

---

## Bug 2: `req.params.id` typed as `string | string[]` — unsafe pass to `getTrialById`

### Description

In `trials.ts`, the `/:id`, `/:id/summary`, and `/:id/analyze` route handlers pass `req.params.id!` directly to `getTrialById(id: string)`. With `@types/express` v5, `req.params` values are typed as `string | string[]` (since Express 5 supports array-valued route parameters in certain configurations). The `!` non-null assertion removes `undefined` but does **not** narrow `string[]` to `string`, so TypeScript correctly reports:

```
Argument of type 'string | string[]' is not assignable to parameter of type 'string'.
  Type 'string[]' is not assignable to type 'string'.
```

I discovered this by running `npx tsc --noEmit`, which surfaced TS2345 errors on `trials.ts` lines 30 and 40.

### Real-World Impact

If `req.params.id` were ever an array (e.g., through Express routing edge cases, middleware behavior, or parameter pollution), `getTrialById` would receive an array instead of a string. The `Map.get()` call would silently coerce it via `.toString()`, producing something like `"NCT-001,NCT-002"`, which would never match any key — resulting in a silent `404` with no indication of the real problem. More importantly, the code cannot be type-checked cleanly, which blocks CI and erodes trust in the type system.

### Fix

**File:** `starter/src/routes/trials.ts`, lines 30, 40, and 59

Narrow the type at each usage site with a runtime guard:

```typescript
const id = req.params.id;
if (typeof id !== "string") {
  res.status(400).json({ error: "Invalid trial ID" });
  return;
}
const trial = getTrialById(id);
```

Alternatively, type the `Request` generic to constrain `params`:

```typescript
router.get("/:id", (req: Request<{ id: string }>, res: Response) => {
  const trial = getTrialById(req.params.id);
  ...
});
```

### Why This Fix Is Correct

The `Request<{ id: string }>` generic tells Express (and TypeScript) that `req.params.id` is exactly `string`, which matches what `getTrialById` expects. This is the idiomatic Express pattern for typed route parameters. The runtime guard alternative adds defense-in-depth if you don't trust the type annotation alone, but for a simple `:id` route parameter, the generic approach is sufficient and clean.

### Alternatives Considered

1. **Cast with `as string`** — quick but unsafe; suppresses the error without actually guaranteeing the type at runtime. If the value were ever an array, the bug would silently propagate.
2. **Runtime `typeof` check with 400 response** — more defensive, catches genuine edge cases. Better for public-facing APIs or when middleware might transform params. Slightly more verbose.
3. **Typed `Request` generic** (chosen) — the standard Express pattern. Zero runtime overhead, fully type-safe, and communicates intent clearly to other developers.

---

## Bug 3: `startDate` sort order is fully inverted due to inconsistent comparison base

### Description

**File:** `starter/src/services/trial-service.ts`, lines 68–84

The sort comparator uses a different base computation for `startDate` than for the other two sort fields:

```typescript
case "enrollment":        cmp = a.enrollment - b.enrollment;            // a−b → ascending base
case "adverseEventRate":  cmp = a.adverseEventRate - b.adverseEventRate; // a−b → ascending base
case "startDate":         cmp = new Date(b.startDate).getTime()
                               - new Date(a.startDate).getTime();        // b−a → descending base ← inconsistent
```

Line 84 then applies: `return sortOrder === "asc" ? cmp : -cmp`

For `enrollment` and `adverseEventRate`, the ternary works correctly — it returns the ascending-base value for `asc` and negates it for `desc`. But for `startDate`, the base is already descending (`b−a`), so the ternary flips the meaning of every `order` value:

- `order=asc` → returns `b−a` → sorts **descending** (wrong)
- `order=desc` (the default) → returns `-(b−a) = a−b` → sorts **ascending** (wrong)

The existing test at line 41–47 of `trials.test.ts` catches this: it calls `listTrials({ sort: "startDate" })` (no explicit order, defaults to `"desc"`) and asserts `dates[i] <= dates[i-1]` (descending). The test fails because the actual output is ascending.

### Real-World Impact

Any client relying on `sort=startDate` — which is the **default sort** when no `sort` param is provided — receives results in the wrong order. Most trial list views would default to showing most-recent-first; instead they get oldest-first. Because `enrollment` and `adverseEventRate` happen to sort correctly, this bug can go unnoticed in manual testing if you only spot-check those fields.

### Fix

**File:** `starter/src/services/trial-service.ts`, line 75–77

Change the `startDate` case to use the same `a−b` ascending base as the other fields:

```typescript
case "startDate":
  cmp = new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
  break;
```

The ternary at line 84 then applies uniformly: `asc` returns `a−b` (ascending), `desc` returns `b−a` (descending). The test at line 41–47 passes after this change.

### Why This Fix Is Correct

All three sort cases should use the same sign convention so the single ternary at the bottom controls direction consistently. The root cause was computing `startDate` as `b−a` rather than `a−b`, which caused the direction flag to invert relative to its intended meaning.

### Alternatives Considered

1. **Change the ternary to `sortOrder === "desc" ? cmp : -cmp`** — this fixes `startDate` but breaks `enrollment` and `adverseEventRate`. Doesn't solve the inconsistency, just moves it.
2. **Add a separate ternary inside the `startDate` case** — would work but hides the inconsistency behind special-casing rather than fixing it.
3. **Fix the base computation** (chosen) — establishes a consistent convention across all cases. Any new sort field added later will follow the same pattern without needing to know about the ternary's direction assumption.

---

## Bug 4: Non-null assertion on `responseRate` crashes for Phase I trials

### Description

**File:** `starter/src/services/analysis-service.ts`, line 84

```typescript
`Current response rate: ${trial.responseRate!.toFixed(1)}%.`
```

`ClinicalTrial.responseRate` is typed as `number | null` (`types.ts` line 13). The `!` non-null assertion suppresses TypeScript's null check, but it does not change runtime behavior — if `responseRate` is `null`, `.toFixed()` throws `TypeError: Cannot read properties of null (reading 'toFixed')`.

NCT-003 (CLARITY-1) is a Phase I dose-escalation trial with `responseRate: null` in `data.ts` line 54, which is correct for an early-phase trial that has not yet measured efficacy. Calling `GET /trials/NCT-003/summary` crashes the request with an unhandled exception. Because the route handler at `trials.ts` line 38–47 has no try-catch, the exception propagates to Express's default error handler and returns a 500 with a stack trace in development.

The `!` operator is the specific reason this is hard to spot: it reads as intentional developer confidence ("I know this is non-null here") rather than as a missing null check.

### Real-World Impact

Any request for the summary of a Phase I trial — the trials most likely to be of active internal interest at a company running early-phase oncology programs — crashes the endpoint. NCT-003 is a Pathos-sponsored trial, making this particularly impactful.

### Fix

**File:** `starter/src/services/analysis-service.ts`, line 84

```typescript
`Current response rate: ${trial.responseRate !== null ? trial.responseRate.toFixed(1) + "%" : "Not yet available"}.`
```

This matches the null handling already used at line 32 of the same file, making the behavior consistent.

### Why This Fix Is Correct

Phase I trials legitimately have no response rate — the primary endpoint is safety and dose-finding, not efficacy. The type system already encodes this with `number | null`. The fix respects the type contract rather than asserting around it.

### Alternatives Considered

1. **Remove `responseRate` from the summary for null cases** — valid, but the sentence should acknowledge the absence of data rather than silently omitting it.
2. **Default to `0` with `?? 0`** — semantically wrong; a 0% response rate is a specific clinical finding, not the same as "not yet measured."
3. **Null-safe string interpolation** (chosen) — mirrors the existing pattern on line 32 and produces a human-readable output consistent with how the prompt builder handles the same field.

---

## Bug 5: Search relevance scores are computed but never used for ranking

### Description

**File:** `starter/src/services/trial-service.ts`, lines 52–87

When `filters.search` is set, the filter block computes a relevance score for each matching trial and attaches it as `_score`:

```typescript
let score = 0;
if (t.name.toLowerCase().includes(query)) score += 3;
if (t.indication.toLowerCase().includes(query)) score += 2;
if (t.primaryEndpoint.toLowerCase().includes(query)) score += 1;
if (t.keyFindings.includes(query)) score += 2;   // (see also Bug 6)
(t as any)._score = score;
return score > 0;
```

After this block, execution falls directly into the sort block at line 65, which always sorts by `filters.sort ?? "startDate"`. The `_score` property is never referenced in the sort comparator. Search results are returned in `startDate` order regardless of how well each trial matched the query.

A search for `"pembrolizumab"` would match NCT-006 (KEYNOTE-522) strongly on both name and indication, giving it a high `_score`, but it would appear in the results sorted by its start date (2017), not by relevance.

### Real-World Impact

Search is the primary way analysts navigate the trial list. Returning results sorted by date rather than relevance means the most-relevant trial may be at the bottom of the list, especially when many trials match weakly on a common term. The feature looks functional (it filters correctly) but delivers a degraded experience that would erode analyst trust.

### Fix

**File:** `starter/src/services/trial-service.ts`, after line 63 (end of `if (filters.search)` block)

When a search query is active and no explicit `sort` was requested, sort by `_score` descending before returning:

```typescript
if (filters.search && !filters.sort) {
  results.sort((a, b) => ((b as any)._score ?? 0) - ((a as any)._score ?? 0));
  return { trials: results, total: results.length };
}
```

This exits early before the generic sort block, preserving relevance order when the user is searching. If the user explicitly passes both `search` and `sort`, the generic sort takes precedence.

### Why This Fix Is Correct

The scoring logic already encodes the right priority: name matches (weight 3) outrank indication matches (weight 2), which outrank endpoint matches (weight 1). Sorting by this score is the intended behavior — the scoring computation is completely correct; the missing piece is applying it.

### Alternatives Considered

1. **Add a separate score-based sort path inside the search block** — equivalent to the fix above, but placing it after the search block is cleaner than interleaving it with the filter logic.
2. **Remove the scoring entirely and just filter** — makes search purely boolean. Loses the ranking signal that the code already invested in computing.
3. **Sort by score, then fall through to the generic sort** — would overwrite the relevance sort with the date sort immediately after. The early return is necessary.

---

## Bug 6: `keyFindings` search uses `Array.includes()` instead of substring matching

### Description

**File:** `starter/src/services/trial-service.ts`, line 59

```typescript
if (t.keyFindings.includes(query)) score += 2;
```

`t.keyFindings` is `string[]`. `Array.prototype.includes()` tests for exact element membership — it checks whether the array contains the string `"fatigue"` as a discrete element, not whether any element contains the substring `"fatigue"`.

The actual `keyFindings` values are complete sentences, for example:

```
"Grade 3+ adverse events in 31.2% of patients, primarily fatigue and nausea"
```

No search query typed by a user will ever be an exact sentence match. This branch contributes zero points to `_score` for every trial on every search, silently. The bug is invisible at the surface because search still returns results (via the name, indication, and endpoint matches), just without the `keyFindings` signal.

### Real-World Impact

`keyFindings` is the richest, most specific field in the data — it contains specific findings like `"RP2D established at 400mg BID"` or `"Photosensitivity in 41% of patients"`. Analysts searching for `"photosensitivity"` or `"DLT"` would expect these findings to surface relevant trials, but the `keyFindings` field is effectively excluded from search.

### Fix

**File:** `starter/src/services/trial-service.ts`, line 59

```typescript
if (t.keyFindings.some(f => f.toLowerCase().includes(query))) score += 2;
```

`Array.some()` iterates the elements; `String.prototype.includes()` on each element performs the substring match.

### Why This Fix Is Correct

The intent — "does this trial's key findings mention the search term?" — is a substring search over an array of strings. `Array.some(f => f.toLowerCase().includes(query))` expresses that intent directly. The `query` is already lowercased at line 53 (`const query = filters.search.toLowerCase()`), so the `toLowerCase()` on each finding ensures case-insensitive matching.

### Alternatives Considered

1. **Join `keyFindings` into a single string and call `.includes()`** — `t.keyFindings.join(" ").toLowerCase().includes(query)` — works but slightly less precise (could match across a word boundary spanning two findings).
2. **Use `Array.find()` instead of `Array.some()`** — equivalent for a boolean check; `some()` is the idiomatic choice when you only need a truthy/falsy result.

---

## Bug 7: Search mutates shared trial objects in the cache

### Description

**File:** `starter/src/services/trial-service.ts`, lines 32 and 60

```typescript
let results = [...trialData];   // line 32 — shallow copy of the array
...
(t as any)._score = score;      // line 60 — mutates the object inside it
```

`[...trialData]` creates a new array, but the `ClinicalTrial` objects inside are the same references stored in `trialCache` (the `Map<string, ClinicalTrial>` built at module load). Assigning `_score` to `t` writes a property onto the original object, permanently, for the lifetime of the process.

After any search request:
- Every trial object in `trialCache` and `trialData` has a `_score` property attached.
- A subsequent `GET /trials/:id` returns a trial object with a `_score` field that was never part of the type and was set by a previous, unrelated search query.
- If two search requests are handled concurrently (Node.js interleaves async operations), they overwrite each other's `_score` values on the same objects. The sort at the end of each request may observe scores set by the other request.

### Real-World Impact

This is a correctness issue that compounds over time: the longer the server runs, the more stale `_score` values accumulate on the objects. The single-trial endpoint (`GET /trials/:id`) begins leaking `_score` in its JSON response after the first search. In a concurrent load scenario, search results could be sorted using scores from a different client's query.

### Fix

**Option A — use a local score map instead of mutating the object:**

```typescript
const scores = new Map<string, number>();
results = results.filter((t) => {
  let score = 0;
  if (t.name.toLowerCase().includes(query)) score += 3;
  if (t.indication.toLowerCase().includes(query)) score += 2;
  if (t.primaryEndpoint.toLowerCase().includes(query)) score += 1;
  if (t.keyFindings.some(f => f.toLowerCase().includes(query))) score += 2;
  if (score > 0) scores.set(t.id, score);
  return score > 0;
});

if (!filters.sort) {
  results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  return { trials: results, total: results.length };
}
```

**Option B — shallow-clone each object before scoring:**

```typescript
results = results
  .map(t => ({ ...t }))
  .filter(t => { ... (t as any)._score = score; return score > 0; });
```

Option A is preferred because it keeps the data objects clean and makes the scoring visible to the type system.

### Why This Fix Is Correct

Trial objects should be treated as read-only data throughout the service layer. Scoring is a computation local to a single request and should not persist beyond it. Using a `Map` scoped to the function call ensures scores are request-local and the shared objects remain unmodified.

### Alternatives Considered

1. **Deep-clone `trialData` at the start of `listTrials`** — prevents all mutations but is expensive for every call, including the many that don't search.
2. **Shallow-clone inside the filter** (`{ ...t }`) — correct but creates new objects on every search, which then get returned to callers who may assume object identity with cache entries.
3. **Score map scoped to the request** (chosen) — zero allocation overhead for non-search calls, no mutation of shared state, type-clean.

---

## Bug 8: Streaming error handler is structurally incapable of handling stream errors

### Description

**Files:** `starter/src/services/analysis-service.ts` lines 52 and 65–67; `starter/src/routes/trials.ts` lines 65–70

`streamAnalysis` calls `response.writeHead(200, ...)` at line 52, before the streaming loop begins. The route handler wraps the call in a try-catch with a guard:

```typescript
// routes/trials.ts
try {
  await streamAnalysis(trial, focus as any, res);
} catch (err) {
  if (!res.headersSent) {
    res.status(500).json({ error: ... });
  }
}
```

Once `writeHead(200)` executes, `res.headersSent` is `true`. Any error thrown during `streamText()` or inside the `for await` loop propagates to this catch block, but the guard `if (!res.headersSent)` evaluates to `false` — the catch body is a no-op. The error is silently swallowed. The client receives a truncated SSE stream with no error event and the connection closes abruptly.

This is not a missing error handler — the handler exists and looks correct. The structural problem is that the HTTP status code (200) is committed before the operation that can fail (the AI stream) is attempted, making it impossible to retroactively signal an error through the HTTP status layer.

### Real-World Impact

OpenAI API errors (rate limits, timeouts, model unavailability) are not rare in production. When they occur, the analyst's UI receives a partial stream and no indication of what went wrong. There is no error logged server-side either — the exception is caught and discarded. From an ops perspective, these failures are invisible.

### Fix

**File:** `starter/src/services/analysis-service.ts`, lines 65–70

Wrap the stream loop in a try-catch and emit an SSE error event before closing:

```typescript
try {
  for await (const chunk of reader) {
    response.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  }
  response.write("data: [DONE]\n\n");
} catch (err) {
  const message = err instanceof Error ? err.message : "Stream error";
  response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
} finally {
  response.end();
}
```

The client can then check each SSE event for an `error` field and display an appropriate message. Server-side, log the error before writing the event.

### Why This Fix Is Correct

The SSE protocol does not support changing the HTTP status code mid-stream. Once headers are sent, the only communication channel is the stream itself. Emitting a structured error event on the stream is the correct mechanism for signaling failures after streaming has begun — this is the same pattern used by OpenAI's own streaming API.

### Alternatives Considered

1. **Move `writeHead` after `streamText()` resolves** — `streamText` in the Vercel AI SDK returns synchronously; the stream is lazy. Delaying `writeHead` until after the first chunk is yielded is possible but complex and still doesn't handle mid-stream failures.
2. **Validate the OpenAI connection before starting** — a preflight call to check API availability adds latency and doesn't eliminate the possibility of failure during the stream.
3. **Emit an SSE error event on failure** (chosen) — minimal change, consistent with SSE semantics, and gives the client actionable information.
