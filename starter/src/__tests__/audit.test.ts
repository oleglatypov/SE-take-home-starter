import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app } from "../server.js";
import * as analysisService from "../services/analysis-service.js";

// ---------------------------------------------------------------------------
// Section 1: Health endpoint
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["content-type"]).toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// Section 2: Data integrity — full trial list
// ---------------------------------------------------------------------------

describe("data integrity", () => {
  it("GET /trials returns exactly 8 trials with no filters", async () => {
    const response = await request(app).get("/trials");
    expect(response.status).toBe(200);
    expect(response.body.trials).toHaveLength(8);
    expect(response.body.total).toBe(8);
    expect(response.body.total).toBe(response.body.trials.length);
  });

  it("all 8 expected trial IDs are present", async () => {
    const response = await request(app).get("/trials");
    const ids = response.body.trials.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual([
      "NCT-001",
      "NCT-002",
      "NCT-003",
      "NCT-004",
      "NCT-005",
      "NCT-006",
      "NCT-007",
      "NCT-008",
    ]);
  });

  it("every trial has required fields with valid shapes", async () => {
    const response = await request(app).get("/trials");
    const VALID_PHASES = ["I", "II", "III"];
    const VALID_STATUSES = ["recruiting", "completed", "terminated"];

    for (const trial of response.body.trials) {
      expect(typeof trial.id).toBe("string");
      expect(typeof trial.name).toBe("string");
      expect(typeof trial.sponsor).toBe("string");
      expect(VALID_PHASES).toContain(trial.phase);
      expect(VALID_STATUSES).toContain(trial.status);
      expect(typeof trial.enrollment).toBe("number");
      expect(Number.isFinite(trial.adverseEventRate)).toBe(true);
      expect(trial.adverseEventRate).toBeGreaterThanOrEqual(0);
      expect(trial.adverseEventRate).toBeLessThanOrEqual(100);
      expect(trial.responseRate === null || typeof trial.responseRate === "number").toBe(true);
      expect(Array.isArray(trial.keyFindings)).toBe(true);
    }
  });

  it("NCT-003 has null responseRate (Phase I dose-escalation)", async () => {
    const response = await request(app).get("/trials");
    const nct003 = response.body.trials.find((t: { id: string }) => t.id === "NCT-003");
    expect(nct003).toBeDefined();
    expect(nct003.responseRate).toBeNull();
    expect(nct003.phase).toBe("I");
  });

  it("NCT-007 is Phase I with non-null responseRate (PSA50 assessed, clinically valid)", async () => {
    const response = await request(app).get("/trials");
    const nct007 = response.body.trials.find((t: { id: string }) => t.id === "NCT-007");
    expect(nct007).toBeDefined();
    expect(nct007.phase).toBe("I");
    expect(nct007.responseRate).toBe(29.4);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Input validation behavior
// ---------------------------------------------------------------------------

describe("input validation gaps", () => {
  it("returns 400 for invalid phase value", async () => {
    const response = await request(app).get("/trials?phase=IV");
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid status value", async () => {
    const response = await request(app).get("/trials?status=active");
    expect(response.status).toBe(400);
  });

  it("returns 400 for negative minEnrollment", async () => {
    const response = await request(app).get("/trials?minEnrollment=-100");
    expect(response.status).toBe(400);
  });

  it("accepts float minEnrollment values", async () => {
    // This is intentionally left as a product decision rather than a bug fix.
    const response = await request(app).get("/trials?minEnrollment=100.5");
    expect(response.status).toBe(200);
    // All returned trials should have enrollment >= 100.5 (i.e., >= 101 since enrollment is integer)
    const trials = response.body.trials as Array<{ enrollment: number }>;
    expect(trials.every((t) => t.enrollment >= 100.5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 4: Sort direction for all 3 sortable fields
// ---------------------------------------------------------------------------

describe("sort directions", () => {
  // Precomputed from data.ts values
  const AE_DESC_ORDER = ["NCT-006", "NCT-008", "NCT-002", "NCT-005", "NCT-004", "NCT-001", "NCT-007", "NCT-003"];
  const ENROLLMENT_DESC_ORDER = ["NCT-006", "NCT-008", "NCT-002", "NCT-005", "NCT-001", "NCT-004", "NCT-007", "NCT-003"];
  const START_DATE_DESC_ORDER = ["NCT-003", "NCT-001", "NCT-007", "NCT-002", "NCT-004", "NCT-008", "NCT-006", "NCT-005"];

  it("sort=adverseEventRate order=desc puts highest AE rate first", async () => {
    const response = await request(app).get("/trials?sort=adverseEventRate&order=desc");
    const ids = response.body.trials.map((t: { id: string }) => t.id);
    expect(ids).toEqual(AE_DESC_ORDER);
  });

  it("sort=adverseEventRate order=asc puts lowest AE rate first", async () => {
    const response = await request(app).get("/trials?sort=adverseEventRate&order=asc");
    const ids = response.body.trials.map((t: { id: string }) => t.id);
    expect(ids).toEqual([...AE_DESC_ORDER].reverse());
  });

  it("sort=enrollment order=desc puts highest enrollment first", async () => {
    const response = await request(app).get("/trials?sort=enrollment&order=desc");
    const ids = response.body.trials.map((t: { id: string }) => t.id);
    expect(ids).toEqual(ENROLLMENT_DESC_ORDER);
  });

  it("sort=enrollment order=asc puts lowest enrollment first", async () => {
    const response = await request(app).get("/trials?sort=enrollment&order=asc");
    const ids = response.body.trials.map((t: { id: string }) => t.id);
    expect(ids).toEqual([...ENROLLMENT_DESC_ORDER].reverse());
  });

  it("sort=startDate order=desc puts newest trial first", async () => {
    const response = await request(app).get("/trials?sort=startDate&order=desc");
    const ids = response.body.trials.map((t: { id: string }) => t.id);
    expect(ids).toEqual(START_DATE_DESC_ORDER);
  });

  it("sort=startDate order=asc puts oldest trial first", async () => {
    const response = await request(app).get("/trials?sort=startDate&order=asc");
    const ids = response.body.trials.map((t: { id: string }) => t.id);
    expect(ids).toEqual([...START_DATE_DESC_ORDER].reverse());
  });

  it("sort is descending by default when only sort field is given", async () => {
    const explicitDesc = await request(app).get("/trials?sort=enrollment&order=desc");
    const defaultOrder = await request(app).get("/trials?sort=enrollment");
    const explicitIds = explicitDesc.body.trials.map((t: { id: string }) => t.id);
    const defaultIds = defaultOrder.body.trials.map((t: { id: string }) => t.id);
    expect(defaultIds).toEqual(explicitIds);
  });
});

// ---------------------------------------------------------------------------
// Section 5: Search field coverage (end-to-end through HTTP)
// ---------------------------------------------------------------------------

describe("search field coverage", () => {
  it("search by name term returns only matching trial", async () => {
    const response = await request(app).get("/trials?search=aurora");
    expect(response.status).toBe(200);
    expect(response.body.trials).toHaveLength(1);
    expect(response.body.trials[0].id).toBe("NCT-001");
  });

  it("search by indication term returns only matching trial", async () => {
    const response = await request(app).get("/trials?search=neuroendocrine");
    expect(response.status).toBe(200);
    expect(response.body.trials).toHaveLength(1);
    expect(response.body.trials[0].id).toBe("NCT-005");
  });

  it("search by primaryEndpoint term returns matching trial", async () => {
    const response = await request(app).get("/trials?search=pathologic+complete+response");
    expect(response.status).toBe(200);
    expect(response.body.trials.some((t: { id: string }) => t.id === "NCT-006")).toBe(true);
  });

  it("search by keyFindings term returns only matching trial", async () => {
    const response = await request(app).get("/trials?search=dose-proportional");
    expect(response.status).toBe(200);
    expect(response.body.trials).toHaveLength(1);
    expect(response.body.trials[0].id).toBe("NCT-003");
  });

  it("search ranks highest-scoring trial first (biliary: name+indication > keyFindings)", async () => {
    const response = await request(app).get("/trials?search=biliary");
    expect(response.status).toBe(200);
    expect(response.body.trials.length).toBeGreaterThan(1);
    // NCT-008 scores 5 (name +3, indication +2); NCT-004 scores 2 (keyFindings only)
    expect(response.body.trials[0].id).toBe("NCT-008");
  });

  it("search with explicit sort overrides relevance ordering", async () => {
    const response = await request(app).get("/trials?search=prostate&sort=enrollment&order=asc");
    const enrollments = response.body.trials.map((t: { enrollment: number }) => t.enrollment);
    for (let i = 1; i < enrollments.length; i++) {
      expect(enrollments[i]).toBeGreaterThanOrEqual(enrollments[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 6: Trial detail and summary endpoints
// ---------------------------------------------------------------------------

describe("GET /trials/:id", () => {
  it("returns 200 with correct trial data for valid ID", async () => {
    const response = await request(app).get("/trials/NCT-002");
    expect(response.status).toBe(200);
    expect(response.body.id).toBe("NCT-002");
    expect(response.body.name).toBe("BEACON-3: Vemurafenib + Cobimetinib in Melanoma");
    expect(response.body.enrollment).toBe(495);
    expect(response.body.phase).toBe("III");
  });

  it("returns 404 with JSON error for unknown ID", async () => {
    const response = await request(app).get("/trials/NCT-999");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(typeof response.body.error).toBe("string");
  });
});

describe("GET /trials/:id/summary", () => {
  it("returns 404 for unknown ID", async () => {
    const response = await request(app).get("/trials/NCT-999/summary");
    expect(response.status).toBe(404);
  });

  it("NCT-003 summary contains 'Not yet available' for null responseRate", async () => {
    const response = await request(app).get("/trials/NCT-003/summary");
    expect(response.status).toBe(200);
    expect(response.body.id).toBe("NCT-003");
    expect(response.body.summary).toContain("Not yet available");
  });

  it("NCT-003 riskScore is 2 (AE≤30→+1, Phase I→+1, null rr→+0, recruiting→+0)", async () => {
    const response = await request(app).get("/trials/NCT-003/summary");
    expect(response.status).toBe(200);
    expect(response.body.riskScore).toBe(2);
  });

  it("NCT-005 riskScore is 5 (AE>50→+3, Phase III→+0, rr 2.0 <20→+2, completed→+0)", async () => {
    const response = await request(app).get("/trials/NCT-005/summary");
    expect(response.status).toBe(200);
    expect(response.body.riskScore).toBe(5);
  });

  it("NCT-002 riskScore is 3 (AE>50→+3, Phase III→+0, rr 61.3 not <20→+0)", async () => {
    const response = await request(app).get("/trials/NCT-002/summary");
    expect(response.status).toBe(200);
    expect(response.body.riskScore).toBe(3);
  });

  it("riskScore is a non-negative integer for every trial", async () => {
    const ids = ["NCT-001", "NCT-002", "NCT-003", "NCT-004", "NCT-005", "NCT-006", "NCT-007", "NCT-008"];
    for (const id of ids) {
      const response = await request(app).get(`/trials/${id}/summary`);
      expect(response.status).toBe(200);
      const { riskScore } = response.body as { riskScore: number };
      expect(typeof riskScore).toBe("number");
      expect(Number.isInteger(riskScore)).toBe(true);
      expect(riskScore).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 7: SSE format and headers (spy-based — no real OpenAI calls)
// ---------------------------------------------------------------------------

describe("POST /trials/:id/analyze SSE format", () => {
  beforeEach(() => {
    vi.spyOn(analysisService, "streamAnalysis").mockImplementation(
      async (_trial, _focus, response) => {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.write('data: {"text":"Hello"}\n\n');
        response.write('data: {"text":" world"}\n\n');
        response.write("data: [DONE]\n\n");
        response.end();
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 for unknown trial ID without calling streamAnalysis", async () => {
    const response = await request(app)
      .post("/trials/NCT-999/analyze")
      .send({ focus: "safety" });
    expect(response.status).toBe(404);
  });

  it("response Content-Type is text/event-stream", async () => {
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({ focus: "safety" });
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });

  it("SSE response body starts with 'data: ' prefix", async () => {
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({ focus: "safety" });
    expect(response.text.startsWith("data: ")).toBe(true);
  });

  it("SSE chunk format is data: {JSON}\\n\\n", async () => {
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({ focus: "safety" });
    expect(response.text).toContain('data: {"text":"Hello"}\n\n');
  });

  it("SSE stream ends with data: [DONE]\\n\\n", async () => {
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({ focus: "safety" });
    expect(response.text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("does not set the X-Accel-Buffering header", async () => {
    // Without this header, Nginx reverse proxies buffer the full stream before
    // forwarding it — silently breaking real-time delivery in any proxied deployment.
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({ focus: "safety" });
    expect(response.headers["x-accel-buffering"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 8: Deployment and hardening notes
// ---------------------------------------------------------------------------

describe("deployment and hardening notes", () => {
  it("note: all endpoints are publicly accessible without credentials", async () => {
    // No authentication middleware exists. Every endpoint accepts unauthenticated requests.
    const response = await request(app).get("/trials");
    expect(response.status).toBe(200);
  });

  it("note: API does not set CORS headers", async () => {
    // No cors() middleware is configured. The server relies on browser default CORS blocking,
    // which is client-side behavior, not a server security control.
    const response = await request(app)
      .get("/trials")
      .set("Origin", "https://malicious-site.example.com");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
