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
});