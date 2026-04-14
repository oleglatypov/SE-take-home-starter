# Bug Report

Priority guide:
- High: valid requests can crash, leak internal details, waste paid resources, or create material operational risk.
- Medium: incorrect API behavior, broken sorting/search/filtering, or misleading successful responses.
- Low: type-safety or workflow defects that do not directly break runtime behavior.

## Bug 1: `TrialFilters` incompatible with `exactOptionalPropertyTypes`

Priority: Medium

Found: `npx tsc --noEmit` failed because `trials.ts` passed `string | undefined` values into `TrialFilters`, while `starter/src/services/trial-service.ts`, lines 4-12, only allowed omitted properties.

Impact: strict TypeScript could not pass in CI, which weakens the value of the project’s strict configuration and blocks clean builds.

Fix: updated `TrialFilters` in `starter/src/services/trial-service.ts`, lines 4-12, so optional fields explicitly allow `undefined`.

Why this fix is correct: it matches how Express query parameters are actually passed at runtime and restores compatibility with `exactOptionalPropertyTypes`.

Alternatives considered: conditionally building the filter object at the call site, or disabling `exactOptionalPropertyTypes`. I chose the interface change because it is the smallest correct fix.

Regression coverage: `starter/src/__tests__/type-regressions.ts` plus `npm test` now typechecks before running Vitest.

---

## Bug 2: `req.params.id` was not safely typed as a string

Priority: Medium

Found: `npx tsc --noEmit` surfaced route-handler errors because `req.params.id` could be `string | string[]`, but `getTrialById` expects `string`.

Impact: builds failed under strict typing, and array-valued route params could silently produce incorrect `404` behavior.

Fix: typed the route params in `starter/src/routes/trials.ts`, lines 80, 89, and 103, so `req.params.id` is treated as `string`.

Why this fix is correct: it aligns the Express route contract with the service function signature and removes an unsafe narrowing gap.

Alternatives considered: a runtime `typeof` guard or an `as string` cast. I chose the typed route generic because it is explicit and type-safe.

Regression coverage: `starter/src/__tests__/type-regressions.ts`.

---

## Bug 3: Null `responseRate` crashed summary generation

Priority: High

Found: `getTrialSummary` called `.toFixed()` on `trial.responseRate!` in `starter/src/services/analysis-service.ts`, line 96. `NCT-003` has `responseRate: null`, so the summary endpoint threw at runtime.

Impact: valid trial data caused a `500` on `/trials/:id/summary`.

Fix: replaced the non-null assertion with explicit null handling in `starter/src/services/analysis-service.ts`, line 96.

Why this fix is correct: `null` is already part of the domain model, so the summary should render missing efficacy data rather than crash.

Alternatives considered: defaulting to `0%` or omitting the sentence entirely. I chose an explicit “Not yet available” branch because it is accurate and stable.

Regression coverage: `starter/src/__tests__/trials.test.ts`.

---

## Bug 4: Unhandled route errors leaked stack traces and filesystem paths

Priority: High

Found: when a route threw, Express fell back to the default development handler and returned HTML with stack details and local paths.

Impact: internal implementation details leaked to clients, and the JSON API returned inconsistent error formats.

Fix: added centralized error middleware in `starter/src/server.ts` after the `/health` route.

Why this fix is correct: the app boundary is the right place to normalize unexpected failures into consistent JSON responses.

Alternatives considered: per-route `try/catch` blocks or a generic constant error string. I chose one central middleware because it is minimal and covers future routes too.

Regression coverage: `starter/src/__tests__/server.test.ts`.

---

## Bug 5: `/analyze` accepted invalid or missing `focus`

Priority: Medium

Found: the route passed `req.body.focus` into `streamAnalysis` with `as any` and no runtime validation.

Impact: malformed requests returned `200` instead of `400`, and invalid values reached the model layer.

Fix: added explicit focus validation in `starter/src/routes/trials.ts`, lines 112-123.

Why this fix is correct: it enforces the existing `AnalysisFocus` contract at the API boundary.

Alternatives considered: leaving the cast in place or introducing Zod for this one field. I chose a direct enum check because it is the smallest correct boundary validation.

Regression coverage: `starter/src/__tests__/server.test.ts`.

---

## Bug 6: `startDate` sort direction was inverted

Priority: Medium

Found: checking the live `/trials` response order showed that `sort=startDate` behaved opposite to the other sort fields.

Impact: default descending sort returned oldest-first data instead of newest-first data.

Fix: normalized the comparator sign in `starter/src/services/trial-service.ts`, lines 86-88.

Why this fix is correct: the shared `sortOrder === "asc" ? cmp : -cmp` logic only works if all fields use the same base comparison direction.

Alternatives considered: flipping the shared ternary or special-casing `startDate`. I chose the comparator fix because it corrects the root inconsistency.

Regression coverage: `starter/src/__tests__/trials.test.ts`.

---

## Bug 7: Invalid and falsy `minEnrollment` values were silently ignored

Priority: Medium

Found: `?minEnrollment=abc` became `NaN`, and the service treated both `NaN` and `0` as falsy because the filter check used truthiness.

Impact: clients could think a filter was applied when the API had actually ignored it.

Fix: validated the query param in `starter/src/routes/trials.ts` and switched the service check to `!== undefined` in `starter/src/services/trial-service.ts`.

Why this fix is correct: it distinguishes missing input from valid `0` and rejects malformed numeric input at the boundary.

Alternatives considered: only fixing the truthiness check or silently coercing invalid input to `undefined`. I chose to fix both failure modes.

Regression coverage: `starter/src/__tests__/server.test.ts` and `starter/src/__tests__/trials.test.ts`.

---

## Bug 8: Invalid `sort` and `order` were silently accepted

Priority: Medium

Found: unknown values fell through to silent defaults, so `GET /trials?sort=bogus&order=sideways` still returned `200`.

Impact: clients could send invalid sort requests and get a successful but misleading response.

Fix: added route-level allowlists in `starter/src/routes/trials.ts`.

Why this fix is correct: allowed values are part of the API contract and should be rejected at the request boundary.

Alternatives considered: silent fallback or throwing inside `listTrials`. I chose explicit boundary validation.

Regression coverage: `starter/src/__tests__/server.test.ts`.

---

## Bug 9: Search had broken matching, unused relevance scoring, and shared-state mutation

Priority: High

Found: the search path used exact `keyFindings` matching, computed a score without using it for default ordering, and mutated shared trial objects with `_score`.

Impact: search missed valid matches, returned weak default ordering, and leaked internal scoring state across requests.

Fix: rewrote the search block in `starter/src/services/trial-service.ts` to use request-scoped scoring and substring matching.

Why this fix is correct: it fixes all three problems without changing the public API shape.

Alternatives considered: keeping `_score` mutation or always forcing relevance order. I chose a request-scoped score map with early return only when no explicit sort is supplied.

Regression coverage: `starter/src/__tests__/trials.test.ts`.

---

## Bug 10: Streaming errors became a no-op after headers were sent

Priority: High

Found: `streamAnalysis` wrote SSE headers before the route-level catch could do anything useful, so mid-stream failures could leave clients with a truncated stream and no structured error event.

Impact: upstream model failures were surfaced poorly and could produce partial, ambiguous SSE responses.

Fix: wrapped the stream loop in `try/catch/finally` inside `starter/src/services/analysis-service.ts` and always closed the response.

Why this fix is correct: after SSE headers are sent, the stream body is the only correct place to communicate failures.

Alternatives considered: ending silently or moving `writeHead` later. I chose in-band SSE error handling because it matches the stream lifecycle.

Regression coverage: `starter/src/__tests__/analysis-service.test.ts`.

---

## Bug 11: Risk scoring penalized strong response rates

Priority: Medium

Found: the risk score originally added risk for high response rate rather than low response rate.

Impact: strong-efficacy trials could appear riskier than weaker ones.

Fix: updated `calculateRiskScore` in `starter/src/services/analysis-service.ts`, lines 118-119, to penalize response rates below 20 instead.

Why this fix is correct: low response rate is a plausible negative signal; high response rate is not.

Alternatives considered: removing the response-rate factor entirely or keeping the original sign. I chose to preserve the signal but correct its direction.

Regression coverage: `starter/src/__tests__/analysis-service.test.ts`.

---

## Bug 12: Array-valued `sponsor` and `search` query params crashed the server

Priority: High

Found: repeated query keys like `?sponsor=A&sponsor=B` became `string[]`, but the route cast them to `string` and the service called `.toLowerCase()` on the array.

Impact: malformed client input caused a `500` instead of a clean `400`.

Fix: added `typeof` guards in `starter/src/routes/trials.ts` before calling `listTrials`.

Why this fix is correct: request-shape validation belongs at the route boundary, not inside the service.

Alternatives considered: coercing arrays to the first element or introducing a validation library for this case. I chose inline guards because they match the existing style and fix the root problem.

Regression coverage: `starter/src/__tests__/server.test.ts`.

---

## Bug 13: Synchronous `streamText()` failure could stall the SSE response forever

Priority: High

Found: `streamText()` and `result.textStream` were originally outside the protected `try` scope, so synchronous SDK initialization failures could skip `response.end()`.

Impact: missing API key or other startup-time model failures could produce a permanently open SSE connection.

Fix: moved the AI SDK call and reader acquisition inside the `try` block in `starter/src/services/analysis-service.ts`.

Why this fix is correct: it guarantees `response.end()` runs for both synchronous and asynchronous failures.

Alternatives considered: patching this in the route catch or wrapping only `streamText()`. I chose the broader `try` scope because it closes the whole class of failures cleanly.

Regression coverage: covered by the streaming error tests in `starter/src/__tests__/analysis-service.test.ts`.

---

## Bug 14: Array-valued `phase` and `status` silently returned empty results

Priority: Medium

Found: repeated query keys became arrays, but unlike `sponsor` and `search`, they did not crash. They just failed equality checks and returned empty `200` responses.

Impact: malformed requests looked like valid “no matches” results.

Fix: added `typeof` guards for `phase` and `status` in `starter/src/routes/trials.ts`.

Why this fix is correct: it makes validation behavior consistent across all string query parameters.

Alternatives considered: normalizing arrays or validating later in `listTrials`. I chose route-level guards for consistency and clarity.

Regression coverage: `starter/src/__tests__/server.test.ts`.

---

## Bug 15: SSE writer ignored backpressure

Priority: High

Found: the stream loop wrote every chunk without checking the return value from `response.write()`.

Impact: slow clients could cause unbounded memory buffering, extra GC pressure, and easier resource exhaustion under concurrent streams.

Fix: added `once("drain", ...)` support to the response interface and awaited drain in `starter/src/services/analysis-service.ts` when `write()` returned `false`.

Why this fix is correct: it follows Node’s writable-stream backpressure contract without changing the happy path.

Alternatives considered: ignoring the return value or refactoring the whole SSE path around `pipeline()`. I chose the inline drain handling because it is minimal and correct.

Regression coverage: `starter/src/__tests__/analysis-service.test.ts`.

---

## Bug 16: Invalid `phase` and `status` enum strings were accepted

Priority: Medium

Found: after array validation, arbitrary strings like `phase=IV` and `status=active` still flowed through and returned empty `200` responses.

Impact: bad input was indistinguishable from a legitimate “no matches” response.

Fix: added explicit allowlists in `starter/src/routes/trials.ts`, lines 11-14 and 20-33.

Why this fix is correct: it aligns runtime validation with the declared union types in `starter/src/types.ts`.

Alternatives considered: allowing silent empty responses or validating inside `listTrials`. I chose boundary validation because this is an API-contract issue.

Regression coverage: `starter/src/__tests__/server.test.ts` and `starter/src/__tests__/audit.test.ts`.

---

## Bug 17: Negative `minEnrollment` was accepted and behaved like no filter

Priority: Medium

Found: the route rejected non-finite values but still accepted negative numbers, which effectively returned the full dataset.

Impact: a semantically invalid query looked like a valid filtered response.

Fix: tightened numeric validation in `starter/src/routes/trials.ts`, lines 36-44, to reject negative values.

Why this fix is correct: negative enrollment thresholds are meaningless for this dataset.

Alternatives considered: also rejecting floats or leaving negatives alone. I chose to reject only the clearly invalid case.

Regression coverage: `starter/src/__tests__/server.test.ts` and `starter/src/__tests__/audit.test.ts`.

---

## Reclassified Note 18: Reverse-proxy SSE buffering

The missing `X-Accel-Buffering: no` header is a deployment hardening issue, not an unconditional app bug in the local environment. I left it documented in `starter/src/__tests__/audit.test.ts` as a note rather than counting it as a defect.

---

## Reclassified Note 19: Authentication and rate limiting

The API is intentionally unauthenticated today. That is a real production concern, especially for a paid LLM-backed route, but it is a product and infrastructure decision rather than an implementation bug in this exercise.

---

## Reclassified Note 20: CORS configuration

The lack of CORS headers matters for certain browser integration models, but it is not an intrinsic backend defect. I left it documented as an integration note rather than a bug.

---

## Bug 21: Client disconnects did not abort upstream model work

Priority: High

Found: the SSE route did not tie the OpenAI request lifetime to the HTTP connection lifetime.

Impact: abandoned streams could continue consuming paid model tokens after the client disconnected.

Fix: added `AbortController` wiring in `starter/src/routes/trials.ts`, lines 119-123, and threaded the signal through `starter/src/services/analysis-service.ts`, lines 41-81.

Why this fix is correct: it stops upstream work when the downstream client is gone.

Alternatives considered: ignoring disconnects or polling writable state later in the stream. I chose request-lifecycle abort because it stops the waste at the correct layer.

Regression coverage: `starter/src/__tests__/analysis-service.test.ts`.

---

## Additional Note: Prompt Reliability

The analysis prompt in `starter/src/services/analysis-service.ts` is functional, but it is still fairly open-ended. A worthwhile non-blocking improvement would be to tell the model to use only the supplied trial data, to explicitly say when supporting evidence is missing, and to treat trial text as data rather than instructions.

## Non-Blocking Improvement

I did not count prompt quality as a core application bug because the current implementation still produces usable output and does not break the API contract. I am documenting it because tightening the prompt would reduce hallucination risk and improve consistency across focus modes.