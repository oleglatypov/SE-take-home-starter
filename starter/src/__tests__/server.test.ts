import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../services/analysis-service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/analysis-service.js")>(
    "../services/analysis-service.js"
  );

  return {
    ...actual,
    getTrialSummary: () => {
      throw new TypeError("Simulated summary failure");
    },
  };
});

import { app } from "../server.js";

describe("server", () => {
  it("returns JSON not HTML when a route throws", async () => {
    const response = await request(app).get("/trials/NCT-003/summary");

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.text).not.toContain("/Users/");
    expect(response.text).not.toContain("TypeError");
  });

  it("returns 400 for invalid focus", async () => {
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({ focus: "bogus" });

    expect(response.status).toBe(400);
  });

  it("returns 400 when focus is missing", async () => {
    const response = await request(app)
      .post("/trials/NCT-001/analyze")
      .send({});

    expect(response.status).toBe(400);
  });

  it("returns 400 for non-numeric minEnrollment", async () => {
    const response = await request(app).get("/trials?minEnrollment=abc");

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid sort field", async () => {
    const response = await request(app).get("/trials?sort=bogus");

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid order value", async () => {
    const response = await request(app).get("/trials?order=sideways");

    expect(response.status).toBe(400);
  });
});