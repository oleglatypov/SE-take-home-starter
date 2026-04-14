import { Router } from "express";
import type { Request, Response } from "express";
import { listTrials, getTrialById } from "../services/trial-service.js";
import {
  streamAnalysis,
  getTrialSummary,
} from "../services/analysis-service.js";
import type { TrialListResponse, ErrorResponse } from "../types.js";

const router = Router();

router.get("/", (req: Request, res: Response<TrialListResponse>) => {
  const { phase, status, minEnrollment, sponsor, search, sort, order } =
    req.query;

  const result = listTrials({
    phase: phase as string | undefined,
    status: status as string | undefined,
    minEnrollment: minEnrollment ? Number(minEnrollment) : undefined,
    sponsor: sponsor as string | undefined,
    search: search as string | undefined,
    sort: sort as string | undefined,
    order: order as string | undefined,
  });

  res.json(result);
});

router.get("/:id", (req: Request<{ id: string }>, res: Response) => {
  const trial = getTrialById(req.params.id);
  if (!trial) {
    res.status(404).json({ error: "Trial not found" });
    return;
  }
  res.json(trial);
});

router.get("/:id/summary", (req: Request<{ id: string }>, res: Response) => {
  const trial = getTrialById(req.params.id);
  if (!trial) {
    res.status(404).json({ error: "Trial not found" });
    return;
  }

  const summary = getTrialSummary(trial);
  res.json(summary);
});

router.post(
  "/:id/analyze",
  async (
    req: Request<{ id: string }, unknown, { focus: string }>,
    res: Response<ErrorResponse>
  ) => {
    const trial = getTrialById(req.params.id);
    if (!trial) {
      res.status(404).json({ error: "Trial not found" });
      return;
    }

    const { focus } = req.body ?? {};

    if (focus !== "safety" && focus !== "efficacy" && focus !== "competitive") {
      res.status(400).json({ error: "Invalid focus" });
      return;
    }

    try {
      await streamAnalysis(trial, focus, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : "Analysis failed",
        });
      }
    }
  }
);

export { router as trialsRouter };
