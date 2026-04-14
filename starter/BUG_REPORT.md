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

I also added compile-time regression coverage for this bug by introducing a typecheck step into the test suite. The project test command now runs `tsc --noEmit && vitest run`, and a dedicated regression file exercises a `listTrials(...)` call with explicit `undefined` values so this incompatibility is caught automatically during CI.

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

**File:** `starter/src/services/analysis-service.ts`, line 84

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

**File:** `starter/src/routes/trials.ts`, lines 61–69

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
