import type { Request } from "express";
import { getTrialById, listTrials } from "../services/trial-service.js";

void listTrials({
  phase: undefined,
  status: undefined,
  minEnrollment: undefined,
  sponsor: undefined,
  search: undefined,
  sort: undefined,
  order: undefined,
});

declare const typedTrialRequest: Request<{ id: string }>;

void getTrialById(typedTrialRequest.params.id);