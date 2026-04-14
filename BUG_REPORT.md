# Bug Report

## Bug 1: `TrialFilters` interface incompatible with `exactOptionalPropertyTypes`

### Description

With `exactOptionalPropertyTypes: true` enabled in `tsconfig.json`, the `TrialFilters` interface in `trial-service.ts` declares optional properties (e.g., `phase?: string`), which means the properties can be *omitted* but cannot be explicitly set to `undefined`. However, the call site in `trials.ts` (lines 67–74) passes query parameters as `string | undefined`, which includes explicit `undefined` values when a query parameter is absent. This creates a type mismatch:

```
Type 'string | undefined' is not assignable to type 'string'.
```

I discovered this by running `npx tsc --noEmit`, which surfaced the TS2379 error at the `listTrials(...)` call in `trials.ts`.

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

I also added compile-time regression coverage for this bug by introducing a typecheck step into the test suite. The project test command now runs `tsc --noEmit && vitest run`, and a dedicated regression file exercises a `listTrials(...)` call with explicit `undefined` values so this incompatibility is caught automatically during CI.

### Alternatives Considered

1. **Filter out `undefined` values at the call site** — build the object conditionally, only including properties that are defined. This would keep the stricter interface but adds verbosity and complexity to the route handler for no real benefit.
2. **Disable `exactOptionalPropertyTypes`** — this would suppress the error globally but weakens the type system for the entire project. Not recommended since the flag catches real bugs elsewhere.
3. **Use a builder/validation layer (e.g., Zod)** — parse and validate query params before passing to `listTrials`. More robust long-term but over-engineered for this specific fix.

Option 1 is the cleanest alternative; I chose the interface change because it's minimal, correct, and idiomatic for codebases that enable `exactOptionalPropertyTypes`.

---

## Bug 2: `req.params.id` typed as `string | string[]` — unsafe pass to `getTrialById`

### Description

In `trials.ts`, the `/:id`, `/:id/summary`, and `/:id/analyze` route handlers originally passed `req.params.id!` directly to `getTrialById(id: string)`. With `@types/express` v5, `req.params` values are typed as `string | string[]` (since Express 5 supports array-valued route parameters in certain configurations). The `!` non-null assertion removes `undefined` but does **not** narrow `string[]` to `string`, so TypeScript correctly reports:

```
Argument of type 'string | string[]' is not assignable to parameter of type 'string'.
  Type 'string[]' is not assignable to type 'string'.
```

I discovered this by running `npx tsc --noEmit`, which surfaced TS2345 errors in the route handlers now located at `trials.ts` lines 80, 89, and 103.

### Real-World Impact

If `req.params.id` were ever an array (e.g., through Express routing edge cases, middleware behavior, or parameter pollution), `getTrialById` would receive an array instead of a string. The `Map.get()` call would silently coerce it via `.toString()`, producing something like `"NCT-001,NCT-002"`, which would never match any key — resulting in a silent `404` with no indication of the real problem. More importantly, the code cannot be type-checked cleanly, which blocks CI and erodes trust in the type system.

### Fix

**File:** `starter/src/routes/trials.ts`, lines 80, 89, and 103

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

I also added compile-time regression coverage for this bug by introducing a typecheck step into the test suite. The project test command now runs `tsc --noEmit && vitest run`, and a dedicated regression file exercises `getTrialById(...)` with a typed route param shape so this mismatch is caught automatically during CI.

### Alternatives Considered

1. **Cast with `as string`** — quick but unsafe; suppresses the error without actually guaranteeing the type at runtime. If the value were ever an array, the bug would silently propagate.
2. **Runtime `typeof` check with 400 response** — more defensive, catches genuine edge cases. Better for public-facing APIs or when middleware might transform params. Slightly more verbose.
3. **Typed `Request` generic** (chosen) — the standard Express pattern. Zero runtime overhead, fully type-safe, and communicates intent clearly to other developers.

---

## Bug 3: Non-null assertion on `responseRate` crashes summary generation

### Description

`ClinicalTrial.responseRate` is typed as `number | null` in `types.ts`, but `getTrialSummary` in `analysis-service.ts` used a non-null assertion and called `.toFixed(1)` directly:

```typescript
`Current response rate: ${trial.responseRate!.toFixed(1)}%.`,
```

That silences TypeScript but does not make the value non-null at runtime. NCT-003 has `responseRate: null`, which is valid for a Phase I trial. Calling `getTrialSummary` for that trial throws `TypeError: Cannot read properties of null (reading 'toFixed')`.

I discovered this by tracing the `GET /trials/:id/summary` path and then reproducing it with the seeded `NCT-003` trial data, which crashed both in direct execution and through the HTTP endpoint.

### Real-World Impact

Any request for a trial summary where the response rate is not yet available would fail with a `500` instead of returning a usable summary. In production, this would break summary views for early-stage trials and cause avoidable server errors on valid clinical data.

### Fix

**File:** `starter/src/services/analysis-service.ts`, line 96

Replace the non-null assertion with an explicit null-safe branch:

```typescript
`Current response rate: ${trial.responseRate !== null ? trial.responseRate.toFixed(1) + "%" : "Not yet available"}.`,
```

I also added two regression tests in `starter/src/__tests__/trials.test.ts` covering the non-throwing behavior and the expected summary text when `responseRate` is `null`.

### Why This Fix Is Correct

The fix preserves the existing behavior for trials that do have a numeric response rate while handling the valid `null` case explicitly. It respects the actual domain model instead of asserting around it.

### Alternatives Considered

1. **Default to `0%`** — incorrect clinically, because `0%` is a measured result, not an unknown value.
2. **Omit the sentence entirely** — avoids the crash but hides that the field is intentionally unavailable.
3. **Use an explicit null-safe string branch** (chosen) — minimal, accurate, and keeps the summary structure stable.

---

## Bug 4: Unhandled route errors leak stack traces and filesystem paths

### Description

The Express app had no centralized error middleware. When a route threw unexpectedly, Express fell back to its default development error handler and returned an HTML response containing stack frames and absolute filesystem paths.

I discovered this by hitting the summary endpoint with seeded data that triggered an exception and observing that the response body included a development stack trace with local paths under `/Users/oleglatypov/...` instead of a JSON API error payload.

### Real-World Impact

In production, this leaks internal implementation details to clients, including stack traces and local file paths. It also breaks the API contract by returning HTML from a JSON API, making client-side error handling inconsistent and exposing information that should stay internal.

### Fix

**File:** `starter/src/server.ts`, after the `/health` route

Add centralized Express error middleware so unexpected route failures are normalized into JSON:

```typescript
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: message });
});
```

I also added a route-level regression test in `starter/src/__tests__/server.test.ts` using `supertest`, and added a small `VITEST` guard around `app.listen(...)` so the test can import `app` without binding a real port.

### Why This Fix Is Correct

This moves unexpected error handling to the correct layer: the application boundary. It prevents Express from falling back to its default HTML development handler and ensures the API always returns structured JSON for server failures, without leaking stack trace metadata.

### Alternatives Considered

1. **Wrap each route in local `try/catch`** — repetitive and easy to miss in future routes.
2. **Use a constant error string** — stricter for production secrecy, but less useful during debugging. The chosen version still avoids stack traces and filesystem paths while preserving the error message.
3. **Add one centralized error middleware** (chosen) — minimal, framework-native, and covers future route errors automatically.

---

## Bug 5: Invalid or missing `focus` is accepted by `/analyze`

### Description

The `/trials/:id/analyze` route read `req.body.focus` and passed it directly into `streamAnalysis` using `focus as any`, with no validation.

That meant both of these invalid requests were accepted:

```json
{"focus":"bogus"}
```

and

```json
{}
```

I discovered this by tracing the analyze route and then confirming it over HTTP: both an invalid `focus` value and a missing `focus` field returned `200` instead of a client error.

### Real-World Impact

In production, this breaks the API contract and allows invalid request data into the AI analysis path. At best, clients get inconsistent behavior for bad inputs. At worst, malformed requests reach the model layer and produce meaningless output or confusing failures that should have been rejected immediately.

### Fix

**File:** `starter/src/routes/trials.ts`, lines 112–123

Replace the direct destructuring and unsafe cast with guarded extraction and enum validation:

```typescript
const { focus } = req.body ?? {};

if (focus !== "safety" && focus !== "efficacy" && focus !== "competitive") {
  res.status(400).json({ error: "Invalid focus" });
  return;
}

await streamAnalysis(trial, focus, res);
```

I also added two route-level regression tests in `starter/src/__tests__/server.test.ts` covering the invalid-focus and missing-focus cases.

### Why This Fix Is Correct

This enforces the runtime contract that was already implied by the `AnalysisFocus` type. It also safely handles cases where `req.body` is missing or undefined by falling back to `{}` before destructuring.

### Alternatives Considered

1. **Leave the `as any` cast in place** — this preserves the bug by bypassing the type system and accepting bad inputs.
2. **Use a Zod schema** — more robust long-term, but larger than necessary for this focused fix.
3. **Add a direct enum check in the route** (chosen) — minimal, explicit, and correct for the current codebase.

---

## Bug 6: `startDate` sort direction was inverted relative to `order`

### Description

The `listTrials` comparator used the opposite base comparison for `startDate` than it used for the other sortable fields.

`enrollment` and `adverseEventRate` both used `a - b`, which makes the base comparison ascending before the shared `sortOrder` logic is applied. But `startDate` used `b - a`:

```typescript
case "startDate":
  cmp = new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
  break;
```

The comparator then returned:

```typescript
return sortOrder === "asc" ? cmp : -cmp;
```

That meant `startDate` was effectively inverted twice relative to the other fields: the default `order="desc"` returned ascending dates, and `order="asc"` returned descending dates.

I discovered this from the existing failing test in `trials.test.ts`, then confirmed it by tracing the comparator logic and checking the live `/trials` response order.

### Real-World Impact

The default trial list order was wrong. Clients expecting newest-first trial data received oldest-first data instead. Because the other sort fields behaved correctly, this inconsistency was easy to miss and would lead to confusing UI behavior in production.

### Fix

**File:** `starter/src/services/trial-service.ts`, lines 86–88

Normalize `startDate` to the same ascending-base comparison used by the other sort fields:

```typescript
case "startDate":
  cmp = new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
  break;
```

I also kept the existing default-order regression coverage and added a second test in `starter/src/__tests__/trials.test.ts` covering the explicit ascending case.

### Why This Fix Is Correct

The shared `sortOrder === "asc" ? cmp : -cmp` logic only works if every sortable field uses the same base sign convention. Changing `startDate` to `a - b` makes it consistent with `enrollment` and `adverseEventRate`, so the shared direction logic behaves correctly for all fields.

### Alternatives Considered

1. **Flip the ternary at the bottom** — this would fix `startDate` but break `enrollment` and `adverseEventRate`.
2. **Special-case `startDate` in the ternary** — this works, but leaves the comparator inconsistent and harder to maintain.
3. **Normalize the `startDate` comparator to the same base direction** (chosen) — smallest root-cause fix, with no unrelated behavior changes.

---

## Bug 7: `minEnrollment` invalid and falsy values were silently ignored

### Description

The `minEnrollment` filter had two distinct failure modes.

At the route layer, the query parameter was parsed with `Number(minEnrollment)` and passed into `listTrials` without validation. That meant a request like `?minEnrollment=abc` produced `NaN`.

At the service layer, the filter was only applied when `filters.minEnrollment` was truthy:

```typescript
if (filters.minEnrollment) {
  results = results.filter((t) => t.enrollment >= filters.minEnrollment!);
}
```

Because both `NaN` and `0` are falsy, malformed input and valid zero-valued input were both silently treated as if the filter were absent.

I discovered this by tracing the list route and then confirming it over HTTP: `GET /trials?minEnrollment=abc` returned `200` with the full result set instead of rejecting the input.

### Real-World Impact

Clients could believe they had applied an enrollment filter when the API had actually ignored it. In production, that leads to misleading query results and makes client-side input mistakes hard to diagnose because the request still succeeds.

### Fix

**Files:** `starter/src/routes/trials.ts` and `starter/src/services/trial-service.ts`

At the route boundary, parse and validate the query parameter before calling `listTrials`:

```typescript
const parsedMinEnrollment =
  minEnrollment === undefined ? undefined : Number(minEnrollment);

if (parsedMinEnrollment !== undefined && !Number.isFinite(parsedMinEnrollment)) {
  res.status(400).json({ error: "Invalid minEnrollment" });
  return;
}
```

At the service layer, distinguish `undefined` from valid falsy numbers:

```typescript
if (filters.minEnrollment !== undefined) {
  results = results.filter((t) => t.enrollment >= filters.minEnrollment);
}
```

I also added a route-level regression test in `starter/src/__tests__/server.test.ts` for non-numeric input and a service-level regression test in `starter/src/__tests__/trials.test.ts` for `minEnrollment: 0`.

### Why This Fix Is Correct

The route now rejects malformed numeric input at the API boundary, and the service no longer conflates `undefined`, `NaN`, and `0`. That preserves the intended meaning of the filter and aligns runtime behavior with client expectations.

### Alternatives Considered

1. **Fix only the service truthiness check** — this would still leave malformed query input unvalidated at the boundary.
2. **Silently coerce invalid numbers to `undefined`** — this preserves the misleading success behavior instead of surfacing the client error.
3. **Validate at the route boundary and use an explicit `undefined` check in the service** (chosen) — minimal, correct, and fixes both failure modes.

---

## Bug 8: Invalid `sort` and `order` values were silently accepted

### Description

The list route accepted arbitrary `sort` and `order` query parameter values and passed them directly into `listTrials`.

That produced two silent failure modes:

- unknown `sort` values fell into the comparator `default` case, which set `cmp = 0`
- unknown `order` values fell through the shared ternary and behaved as descending

In both cases the API returned `200` with no indication that the provided parameters were invalid or ignored.

I discovered this by tracing the list route and then confirming it over HTTP: `GET /trials?sort=bogus&order=sideways` returned `200` instead of a client error.

### Real-World Impact

Clients could send invalid sorting parameters and receive a successful response that did not match the requested contract. In production, that creates confusing behavior, makes client bugs harder to spot, and can lead consumers to trust an ordering the API did not actually apply.

### Fix

**File:** `starter/src/routes/trials.ts`

Add route-level allowlists before calling `listTrials`:

```typescript
const VALID_SORT = ["enrollment", "startDate", "adverseEventRate"] as const;
const VALID_ORDER = ["asc", "desc"] as const;

if (sort !== undefined && !VALID_SORT.includes(sort as typeof VALID_SORT[number])) {
  res.status(400).json({ error: "Invalid sort field" });
  return;
}

if (order !== undefined && !VALID_ORDER.includes(order as typeof VALID_ORDER[number])) {
  res.status(400).json({ error: "Invalid order value" });
  return;
}
```

I also added two route-level regression tests in `starter/src/__tests__/server.test.ts` covering invalid `sort` and invalid `order` values.

### Why This Fix Is Correct

The accepted values for `sort` and `order` are part of the API contract, so validating them at the route boundary is the correct place to reject malformed input. This prevents silent fallback behavior while keeping the service logic unchanged for valid requests.

### Alternatives Considered

1. **Leave the current fallback behavior in place** — this preserves the bug by silently accepting invalid client input.
2. **Throw from `listTrials` on invalid values** — workable, but request validation belongs at the boundary rather than inside the query function.
3. **Validate with route-level allowlists** (chosen) — minimal, explicit, and consistent with the other input-validation fixes.

---

## Bug 9: Search had broken matching, unused relevance scoring, and shared-state mutation

### Description

The search path in `listTrials` had three related bugs in the same block.

First, it used `t.keyFindings.includes(query)`, which checks exact array-element equality rather than substring containment. Because `keyFindings` entries are full sentences, normal search terms inside those sentences never matched.

Second, it computed a relevance score but never used that score for default ordering. After the search filter ran, execution always fell through to the generic sort block, which defaulted to sorting by `startDate` rather than relevance.

Third, it stored the score by mutating the shared trial objects with `(t as any)._score = score`. Since `results = [...trialData]` only clones the array and not the trial objects themselves, that mutation leaked into `trialData` and `trialCache`, causing later responses to expose an undocumented `_score` property.

I discovered this by tracing the `if (filters.search)` block, then confirming the effects over HTTP and by inspecting returned trial objects after search requests.

### Real-World Impact

In production, search would miss valid matches found inside `keyFindings`, return date-ordered results instead of relevance-ordered results, and leak internal scoring state into unrelated API responses. That is both a search-quality bug and a data-integrity bug.

### Fix

**File:** `starter/src/services/trial-service.ts`, search block in `listTrials`

Replace the shared-object mutation and broken exact-match logic with request-scoped scoring:

```typescript
if (filters.search) {
  const query = filters.search.toLowerCase();
  const scores = new Map<string, number>();

  results = results.filter((t) => {
    let score = 0;
    if (t.name.toLowerCase().includes(query)) score += 3;
    if (t.indication.toLowerCase().includes(query)) score += 2;
    if (t.primaryEndpoint.toLowerCase().includes(query)) score += 1;
    if (t.keyFindings.some((finding) => finding.toLowerCase().includes(query))) {
      score += 2;
    }
    if (score > 0) {
      scores.set(t.id, score);
    }
    return score > 0;
  });

  if (!filters.sort) {
    results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
    return { trials: results, total: results.length };
  }
}
```

I also added three regression tests in `starter/src/__tests__/trials.test.ts` covering sentence-level `keyFindings` matching, relevance ordering, and the absence of leaked `_score` properties on cached trial objects.

### Why This Fix Is Correct

It fixes the matching logic, keeps relevance scores scoped to the request, and applies relevance ordering only when the caller did not explicitly request another sort field. That preserves the current API shape while making the search path internally consistent.

### Alternatives Considered

1. **Keep storing `_score` on the trial objects** — this preserves cross-request mutation and leaks internal state.
2. **Always sort by relevance even when `sort` is provided** — this would override explicit caller intent.
3. **Use a request-scoped score map and early-return only for default search ordering** (chosen) — minimal, correct, and fixes all three bugs together.

---

## Bug 10: Streaming error handling became a no-op after headers were sent

### Description

`streamAnalysis` sent the SSE headers before entering the stream loop:

```typescript
response.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
});
```

Once those headers were written, `res.headersSent` became `true`. That made the route-level catch in `trials.ts` structurally ineffective for any error that happened during streaming, because it only responded when `!res.headersSent`.

The original `streamAnalysis` loop had no internal `try/catch`, so a mid-stream failure from the OpenAI client would stop the stream without writing a terminal error event, and the client could be left with a truncated SSE response.

I discovered this by tracing the order of `writeHead(...)` and the downstream catch logic, then validating it with a dedicated unit test that forces the async text stream to throw mid-stream.

### Real-World Impact

In production, upstream model failures such as timeouts, disconnects, or rate-limit errors could produce silently broken analysis streams. Clients would receive partial output with no structured error event and no reliable terminal signal explaining what happened.

### Fix

**File:** `starter/src/services/analysis-service.ts`, stream loop in `streamAnalysis`

Wrap the async stream loop in `try/catch/finally` and emit an SSE error event before always ending the response:

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

I also added an isolated regression test in `starter/src/__tests__/analysis-service.test.ts` that mocks the AI stream, forces a mid-stream failure, and verifies that `end()` is still called and an error event is written.

### Why This Fix Is Correct

Once SSE headers are sent, the stream body is the only valid channel left for communicating an error to the client. Handling the failure inside `streamAnalysis` ensures that mid-stream failures are surfaced in-band and that the response is always closed cleanly.

### Alternatives Considered

1. **End the stream without writing an error event** — better than hanging, but still opaque to the client.
2. **Move `writeHead(...)` until after the first chunk** — more complex and still does not solve mid-stream failure handling.
3. **Catch inside the stream loop, emit an error event, and always `end()`** (chosen) — minimal, explicit, and correct for the SSE lifecycle.

---

## Bug 11: Risk scoring treated high response rate as a negative signal

### Description

The risk score calculation added points when a trial had a response rate above 30%:

```typescript
if (trial.responseRate !== null && trial.responseRate > 30) {
  score += 2;
}
```

That inverted the intended meaning of the score. A high response rate is generally a positive efficacy outcome, not a reason to increase clinical risk. The code was effectively penalizing strong trial performance.

I discovered this by reviewing the scoring logic after the earlier summary fix and checking how the response-rate branch interacted with the rest of the risk rubric.

### Real-World Impact

In production, trials with strong efficacy would appear riskier than similar trials with poorer efficacy. That would distort any consumer relying on `riskScore` for prioritization, summary displays, or downstream ranking logic.

### Fix

**File:** `starter/src/services/analysis-service.ts`, lines 118–119 in `calculateRiskScore`

Change the signal so poor efficacy increases risk instead of strong efficacy:

```typescript
if (trial.responseRate !== null && trial.responseRate < 20) {
  score += 2;
}
```

I also added a regression test in `starter/src/__tests__/analysis-service.test.ts` using two otherwise-identical trial objects, proving that a high response-rate trial does not receive a higher risk score than a low response-rate trial.

### Why This Fix Is Correct

Low response rate is a plausible negative efficacy signal, while high response rate is not. This change preserves response rate as a meaningful input to the score without inverting its clinical interpretation.

### Alternatives Considered

1. **Remove the response-rate component entirely** — simpler, but throws away a legitimate efficacy signal.
2. **Keep penalizing high response rate** — clinically backwards and inconsistent with the rest of the score semantics.
3. **Penalize clearly poor response rate instead** (chosen) — minimal, defensible, and aligned with the intended meaning of risk.

---

## Bug 12: Array-valued `sponsor` and `search` query parameters crash the server

### Description

Express parses a query string like `?sponsor=A&sponsor=B` as `{ sponsor: ["A", "B"] }` — a `string[]` rather than a `string`. The list route destructured `sponsor` and `search` and cast them with `as string | undefined`:

```typescript
sponsor: sponsor as string | undefined,
search:  search  as string | undefined,
```

TypeScript's `as` cast is a compile-time assertion only; it does not narrow the runtime value. When either parameter was actually an array, the service called `.toLowerCase()` on it and threw:

```
TypeError: sponsor.toLowerCase is not a function
```

This produced a `500` instead of a `400`, even though the fault lay entirely with the client's request. The other parameters were already safe: `minEnrollment` is parsed through `Number()` with `isFinite` guard; `sort` and `order` fail the allowlist check and return `400`; `phase` and `status` fall through to equality comparisons that simply return no results.

I discovered this by auditing the route handler for parameters that consumed string methods downstream without a prior type guard.

### Real-World Impact

Any client or attacker that sends duplicate query parameters causes the API to crash with a `500` instead of receiving a proper `400`. Beyond the broken error contract, this is an easy denial-of-service surface: a single repeated query key is enough to crash a request handler. It also masks real client-side bugs because the error message reveals nothing about what was wrong with the input.

### Fix

**File:** `starter/src/routes/trials.ts`

Add `typeof` guards for both parameters after the existing `order` validation and before the `listTrials` call:

```typescript
if (sponsor !== undefined && typeof sponsor !== "string") {
  res.status(400).json({ error: "Invalid sponsor" });
  return;
}

if (search !== undefined && typeof search !== "string") {
  res.status(400).json({ error: "Invalid search" });
  return;
}
```

The downstream `as string | undefined` casts are now safe because the guards have already narrowed the values at runtime.

I also added two route-level regression tests in `starter/src/__tests__/server.test.ts` covering the array-valued `sponsor` and `search` cases.

### Why This Fix Is Correct

The root cause is a missing runtime type guard at the API boundary. Adding `typeof` checks is the minimal, inline fix that matches the validation pattern already established by `minEnrollment`, `sort`, and `order`. It rejects malformed input at the boundary, returns a clear `400`, and leaves the service layer untouched.

### Alternatives Considered

1. **Normalize arrays to their first element** — silently accepts parameter pollution and may confuse clients whose duplicate parameters were a mistake.
2. **Use a validation library (e.g. Zod)** — more robust long-term, but over-engineered for this single fix and inconsistent with the existing inline pattern.
3. **Add inline `typeof` guards at the route boundary** (chosen) — minimal, explicit, consistent with existing validation style, and fixes the problem at the correct layer.

---

## Bug 13: Synchronous `streamText()` failure leaves SSE response permanently stalled

### Description

`streamAnalysis` committed the SSE response headers before entering the guarded stream loop, but only the `for await` loop itself was inside `try/catch/finally`:

```typescript
response.writeHead(200, { ... });  // headers committed here

const result = streamText({        // outside try — any throw escapes
  model: openai("gpt-4o-mini"),
  prompt,
});

const reader = result.textStream;  // also outside try

try {
  for await (const chunk of reader) { ... }
} catch (err) {
  response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
} finally {
  response.end();                  // never reached if streamText() threw
}
```

If `openai(...)` or `streamText(...)` threw synchronously — for example due to a missing API key environment variable, an invalid model identifier, or SDK initialization failure — the exception propagated directly to the route catch block in `trials.ts`. There, `res.headersSent` was already `true`, so the `if (!res.headersSent)` guard suppressed the JSON error response and `response.end()` was never called. The client was left with a permanently open, stalled SSE connection.

I discovered this by auditing the scope boundary of the `try` block relative to the `writeHead` call.

### Real-World Impact

Any synchronous failure in the AI SDK initialization path — missing `OPENAI_API_KEY`, invalid model string, SDK misconfiguration — would produce a hung SSE connection rather than a recoverable error. The client has no way to distinguish a stalled stream from a slow one, making this failure mode silent and difficult to diagnose. In production, this would result in clients blocking indefinitely with no structured error event and no connection close signal.

### Fix

**File:** `starter/src/services/analysis-service.ts`

Move `streamText(...)` and `result.textStream` inside the existing `try` block so that `finally { response.end() }` is always reached regardless of where the failure originates:

```typescript
response.writeHead(200, { ... });

try {
  const result = streamText({
    model: openai("gpt-4o-mini"),
    prompt,
  });

  const reader = result.textStream;

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

### Why This Fix Is Correct

Once SSE headers are committed, the response body is the only channel available to signal errors or close the connection. Wrapping the entire AI SDK call sequence in a single `try/catch/finally` ensures `response.end()` is always called and any failure — whether synchronous or mid-stream — is surfaced as a structured in-band error event before the connection closes.

### Alternatives Considered

1. **Wrap only the `streamText()` call in a separate try and re-throw** — adds complexity without benefit; the existing `catch` already handles all error types.
2. **Check `res.headersSent` in the route catch and call `res.end()`** — treats the symptom at the wrong layer; the route handler should not need to know about SSE lifecycle internals.
3. **Expand the `try` scope to include `streamText()` and `result.textStream`** (chosen) — one-line scope change, no behavioral change for the happy path, and closes the stall gap entirely.

---

## Bug 14: Array-valued `phase` and `status` query parameters silently return empty results

### Description

Like `sponsor` and `search` (Bug 12), the `phase` and `status` query parameters were passed to `listTrials` with `as string | undefined` casts and no runtime type guard. When a client sent duplicate parameters — `?phase=III&phase=II` or `?status=recruiting&status=completed` — Express set the value to a `string[]`.

Unlike `sponsor` and `search`, these parameters do not call string methods on the value, so there was no crash. Instead, the array values failed the strict equality checks in the service:

```typescript
results = results.filter((t) => t.phase === filters.phase);   // ["III","II"] never equals a string
results = results.filter((t) => t.status === filters.status); // same
```

Both requests returned `200 {"trials":[],"total":0}` — a successful, plausible-looking response that silently discarded the filter entirely. I verified this in-process with `GET /trials?phase=III&phase=II` and `GET /trials?status=recruiting&status=completed`. The asymmetry was also observable against the already-fixed `sponsor` and `search` parameters, which returned 400 for the same class of input.

### Real-World Impact

Clients that accidentally or deliberately repeat these query parameters receive an empty result set with no indication that their input was malformed. A UI querying for active Phase III trials and getting an empty list — with a `200` status — would silently show no data rather than surfacing an error. This is the same parameter-pollution surface as Bug 12, just with a quieter failure mode that is harder to detect.

### Fix

**File:** `starter/src/routes/trials.ts`

Add `typeof` guards for `phase` and `status` before the `minEnrollment` parsing, following the same pattern as Bug 12:

```typescript
if (phase !== undefined && typeof phase !== "string") {
  res.status(400).json({ error: "Invalid phase" });
  return;
}

if (status !== undefined && typeof status !== "string") {
  res.status(400).json({ error: "Invalid status" });
  return;
}
```

I also added two route-level regression tests in `starter/src/__tests__/server.test.ts` covering the array-valued `phase` and `status` cases.

### Why This Fix Is Correct

All six string query parameters on this route (`phase`, `status`, `minEnrollment`, `sponsor`, `search`, `sort`, `order`) now reject non-string values at the API boundary and return a consistent `400`. This closes the asymmetry introduced by Bug 12 and makes the route's validation behavior uniform across all parameters.

### Alternatives Considered

1. **Normalize arrays to their first element** — silently accepts parameter pollution; masks client-side mistakes rather than surfacing them.
2. **Validate inside `listTrials`** — wrong layer; request shape validation belongs at the route boundary, not inside the query function.
3. **Add inline `typeof` guards at the route boundary** (chosen) — identical to the Bug 12 fix, minimal, and makes the validation contract consistent across all parameters.

---

## Bug 15: SSE writer ignores backpressure, causing unbounded memory buffering under slow clients

### Description

In Node.js, `writable.write(chunk)` returns `false` when the socket's internal buffer has reached its high-water mark, signalling that the caller should stop writing and wait for the `drain` event before continuing. The streaming loop in `streamAnalysis` called `response.write()` on every LLM chunk without checking the return value:

```typescript
for await (const chunk of reader) {
  response.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
}
```

Node does not drop buffered writes — data is still delivered — but it will keep accepting chunks into memory regardless of how fast the client is consuming them. Under a slow client (e.g. a mobile browser on a poor connection, or a client deliberately reading slowly), every concurrent analysis stream accumulates its entire remaining output in the process heap until the socket drains or the connection closes.

Additionally, the `response` interface parameter did not declare `once`, which meant the backpressure pattern could not be implemented without a type change, and type-checking gave no signal that the omission existed.

I discovered this by auditing the streaming loop for ignored return values and comparing the interface against Node's `Writable` contract.

### Real-World Impact

Under normal load the individual chunk sizes are small (single tokens from the LLM) and a single analysis is bounded to a few kilobytes, so the issue is latent rather than immediately destructive. Under concurrent streams with slow clients — a realistic production scenario for an analytics product used in a browser — memory grows linearly with the number of stalled streams and the size of each model response. At sufficient concurrency this causes GC pressure, increased latency for all requests, and eventually OOM crashes. It is also an easy target for a slow-loris style resource exhaustion: open many analysis streams and read from them slowly.

### Fix

**File:** `starter/src/services/analysis-service.ts`

Add `once` to the response interface and pause iteration when `write()` signals backpressure:

```typescript
response: {
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  once: (event: "drain", listener: () => void) => void;
  end: () => void;
}
```

```typescript
for await (const chunk of reader) {
  const ok = response.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  if (!ok) await new Promise<void>((resolve) => response.once("drain", resolve));
}
```

The `once` method on the real `http.ServerResponse` fires when the socket buffer has emptied, resuming the loop at the correct time with no data loss.

I also updated the existing test mock to satisfy the interface (adding a no-op `once` — it is never called because the mock's `write` always returns `true`) and added a dedicated regression test that simulates a backpressured first write, verifies `once("drain", ...)` is called, and immediately resolves it so the loop can complete.

### Why This Fix Is Correct

Respecting the `write()` return value is the standard Node.js backpressure contract for writable streams. Awaiting `drain` before the next iteration pauses the `for await` loop without blocking the event loop, preserving Node's cooperative multitasking model. No data is lost and the happy path (client keeping up) is completely unaffected.

### Alternatives Considered

1. **Ignore the return value** — current behavior; correct for data delivery but unbounded for memory.
2. **Use `pipeline()` or `stream.pipeline`** — the correct long-term solution for pipeline backpressure, but requires restructuring the SSE response as a readable stream, which is a larger change than warranted here.
3. **Await `drain` inline when `write()` returns `false`** (chosen) — minimal, idiomatic, and slots directly into the existing `for await` loop without restructuring anything.

---

## Bug 16: `phase` and `status` accepted invalid enum values and silently returned empty results

### Description

The list route already rejected array-valued `phase` and `status` query parameters, but it only checked that the values were strings. That meant invalid enum strings like `GET /trials?phase=IV` and `GET /trials?status=active` passed the route layer, flowed into `listTrials`, and returned `200 {"trials":[],"total":0}`.

This was a real API-contract bug: the domain model only allows `"I" | "II" | "III"` for phase and `"recruiting" | "completed" | "terminated"` for status, but the API accepted arbitrary strings.

### Real-World Impact

Clients with typos or stale enum values saw a successful empty result set instead of a validation error. In production this is misleading because it makes bad input indistinguishable from a legitimate “no matches” response.

### Fix

**File:** `starter/src/routes/trials.ts`, lines 11–14 and 20–33

Add allowlists at the route boundary and reject any string that falls outside the supported enums:

```typescript
const VALID_PHASE = ["I", "II", "III"] as const;
const VALID_STATUS = ["recruiting", "completed", "terminated"] as const;

if (
  phase !== undefined &&
  (typeof phase !== "string" || !VALID_PHASE.includes(phase as typeof VALID_PHASE[number]))
) {
  res.status(400).json({ error: "Invalid phase" });
  return;
}

if (
  status !== undefined &&
  (typeof status !== "string" || !VALID_STATUS.includes(status as typeof VALID_STATUS[number]))
) {
  res.status(400).json({ error: "Invalid status" });
  return;
}
```

I also added regression coverage in `starter/src/__tests__/server.test.ts`, lines 87–103, and updated `starter/src/__tests__/audit.test.ts` to assert the corrected behavior.

### Why This Fix Is Correct

The route boundary is the right place to reject malformed client input. This makes runtime behavior consistent with the literal union types already declared in `types.ts` and prevents silent fallback to an empty result set.

### Alternatives Considered

1. **Keep returning empty `200` responses for unknown values** — masks client mistakes and violates the typed contract.
2. **Validate inside `listTrials`** — possible, but request-shape validation belongs at the route boundary.
3. **Add route-level allowlists** (chosen) — minimal, explicit, and consistent with the existing `sort`/`order` validation pattern.

---

## Bug 17: Negative `minEnrollment` values were accepted and behaved like no filter

### Description

The route already parsed `minEnrollment` with `Number(...)` and rejected non-finite values like `abc`, but it still accepted negative numbers. A request such as `GET /trials?minEnrollment=-100` passed validation and effectively behaved like no filter because all seeded trials have enrollment counts greater than or equal to zero.

I intentionally did **not** treat float values like `100.5` as part of this bug. That is a product decision rather than a clear runtime defect in the current API contract.

### Real-World Impact

Clients could send a negative enrollment filter and receive the full dataset with a `200`, which is misleading. The request appears valid and filtered even though it is semantically nonsensical.

### Fix

**File:** `starter/src/routes/trials.ts`, lines 36–44

Tighten the existing numeric validation so negative values are rejected at the route boundary:

```typescript
const parsedMinEnrollment =
  minEnrollment === undefined ? undefined : Number(minEnrollment);

if (
  parsedMinEnrollment !== undefined &&
  (!Number.isFinite(parsedMinEnrollment) || parsedMinEnrollment < 0)
) {
  res.status(400).json({ error: "Invalid minEnrollment" });
  return;
}
```

I also added a route-level regression test in `starter/src/__tests__/server.test.ts`, lines 99–103, and updated `starter/src/__tests__/audit.test.ts` to assert the fixed behavior for negative input.

### Why This Fix Is Correct

Negative enrollment thresholds are never meaningful for this dataset. Rejecting them at the boundary prevents a misleading successful response while preserving the existing accepted behavior for non-negative numeric input.

### Alternatives Considered

1. **Leave negative values accepted** — technically predictable, but misleading because the query appears filtered when it is not.
2. **Also reject floats** — defensible, but more of a product/contract decision than a clear bug in the current implementation.
3. **Reject only negative values** (chosen) — minimal, clearly justified, and aligned with the actual bug we observed.

---

## Reclassified Note 18: SSE reverse-proxy buffering depends on deployment topology

The missing `X-Accel-Buffering: no` header is a valid production hardening improvement when the service is deployed behind Nginx or another buffering reverse proxy, but it is not an unconditional application bug in the current local/runtime environment.

I left this documented in `starter/src/__tests__/audit.test.ts` as a deployment note rather than counting it as a functional bug.

---

## Reclassified Note 19: Authentication and rate limiting are product hardening requirements

The API is intentionally unauthenticated today. That is a real production concern, especially because `/trials/:id/analyze` proxies to a paid LLM, but it is a product/infrastructure requirement rather than a defect in the current implementation.

I reclassified this from “bug” to “hardening note” and left the current behavior documented in `starter/src/__tests__/audit.test.ts`.

---

## Reclassified Note 20: CORS policy is an integration concern, not a server defect

The server currently does not configure CORS headers. That matters if this API is meant to be called directly from a separate browser origin, but it is not an intrinsic bug in the backend itself.

I reclassified this from “bug” to “hardening note” and left the current behavior documented in `starter/src/__tests__/audit.test.ts`.

---

## Bug 21: Missing client-disconnect abort allowed abandoned analysis streams to keep consuming LLM work

### Description

The analysis route started a streaming OpenAI call but did not tie that upstream request to the lifetime of the HTTP client connection. If the client disconnected mid-stream, the server could continue consuming model output and tokens even though no one was still listening.

### Real-World Impact

In production, abandoned analysis streams waste paid LLM capacity and can contribute to unnecessary rate-limit pressure. This is especially relevant for browser clients that navigate away, reload, or drop network connectivity during an SSE response.

### Fix

**Files:** `starter/src/routes/trials.ts`, lines 119–123; `starter/src/services/analysis-service.ts`, lines 41–81

Thread an `AbortSignal` from the request lifecycle into `streamText(...)` and suppress the in-band error write when the signal was intentionally aborted:

```typescript
const controller = new AbortController();
req.once("close", () => controller.abort());

await streamAnalysis(trial, focus, res, controller.signal);
```

```typescript
export async function streamAnalysis(
  trial: ClinicalTrial,
  focus: AnalysisFocus,
  response: { ... },
  signal?: AbortSignal
): Promise<void> {
  const result = streamText({
    model: openai("gpt-4o-mini"),
    prompt,
    ...(signal ? { abortSignal: signal } : {}),
  });

  ...

  } catch (err) {
    if (!signal?.aborted) {
      response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    }
  } finally {
    response.end();
  }
}
```

I added regression coverage in `starter/src/__tests__/analysis-service.test.ts`, lines 185–210, proving that the signal is forwarded to `streamText(...)`, the stream still ends cleanly, and no spurious SSE error event is written on an intentional abort.

### Why This Fix Is Correct

This ties the upstream LLM request lifetime to the downstream HTTP connection lifetime. Once the client disconnects, the server aborts the model request instead of continuing work that can no longer be delivered.

### Alternatives Considered

1. **Ignore disconnects** — simplest, but wastes tokens and quota.
2. **Poll writable state inside the loop** — detects symptoms later and does not stop the upstream model request.
3. **Use `AbortController` on `req.close` and pass the signal through** (chosen) — minimal, explicit, and stops the wasted upstream work at the correct layer.
