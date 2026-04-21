import { Router } from "express";
import type { Request, Response } from "express";
import { listTrials, getTrialById } from "../services/trial-service.js";
import {
  streamAnalysis,
  getTrialSummary,
} from "../services/analysis-service.js";
import type { TrialListResponse, ErrorResponse } from "../types.js";

const router = Router();
const VALID_PHASE = ["I", "II", "III"] as const;
const VALID_STATUS = ["recruiting", "completed", "terminated"] as const;
const VALID_SORT = ["enrollment", "startDate", "adverseEventRate"] as const;
const VALID_ORDER = ["asc", "desc"] as const;

router.get("/", (req: Request, res: Response<TrialListResponse | ErrorResponse>) => {
  const { phase, status, minEnrollment, sponsor, search, sort, order } = req.query;

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

  const parsedMinEnrollment = minEnrollment === undefined ? undefined : Number(minEnrollment);

  if (
    parsedMinEnrollment !== undefined &&
    (!Number.isFinite(parsedMinEnrollment) || parsedMinEnrollment < 0)
  ) {
    res.status(400).json({ error: "Invalid minEnrollment" });
    return;
  }

  if (sort !== undefined && !VALID_SORT.includes(sort as typeof VALID_SORT[number])) {
    res.status(400).json({ error: "Invalid sort field" });
    return;
  }

  if (order !== undefined && !VALID_ORDER.includes(order as typeof VALID_ORDER[number])) {
    res.status(400).json({ error: "Invalid order value" });
    return;
  }

  if (sponsor !== undefined && typeof sponsor !== "string") {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }

  if (search !== undefined && typeof search !== "string") {
    res.status(400).json({ error: "Invalid search" });
    return;
  }

  const result = listTrials({
    phase: phase as string | undefined,
    status: status as string | undefined,
    minEnrollment: parsedMinEnrollment,
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
      const controller = new AbortController();
      // Abort only when the response stream is actually closed by the client.
      res.once("close", () => controller.abort());

      await streamAnalysis(trial, focus, res, controller.signal);
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
