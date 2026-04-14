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
