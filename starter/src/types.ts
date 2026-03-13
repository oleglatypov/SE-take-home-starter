export interface ClinicalTrial {
  id: string;
  name: string;
  sponsor: string;
  phase: "I" | "II" | "III";
  status: "recruiting" | "completed" | "terminated";
  indication: string;
  primaryEndpoint: string;
  enrollment: number;
  startDate: string;
  estimatedCompletionDate: string;
  adverseEventRate: number;
  responseRate: number | null;
  keyFindings: string[];
}

export type AnalysisFocus = "safety" | "efficacy" | "competitive";

export interface TrialListResponse {
  trials: ClinicalTrial[];
  total: number;
}

export interface AnalyzeRequest {
  focus: AnalysisFocus;
}

export interface ErrorResponse {
  error: string;
}

export interface PatientRecord {
  patientId: string;
  trialId: string;
  siteId: string;
  enrollmentDate: string;
  age: number;
  sex: "M" | "F" | "Other";
  weight: number;
  doseLevel: string;
  adverseEvents: string[];
  labNotes: string;
  responseAssessment: string | null;
  lastVisitDate: string;
  status: "active" | "completed" | "withdrawn" | "screen_fail";
}

export interface PipelineResult {
  clean: PatientRecord[];
  quarantined: Array<{ record: Record<string, string>; reasons: string[] }>;
  summary: {
    totalInput: number;
    totalClean: number;
    totalQuarantined: number;
    totalDropped: number;
    issuesFound: Record<string, number>;
  };
}
