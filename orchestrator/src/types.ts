// Shapes from CONTRACT.md. Keep these in sync with that file.

export type HnItemType = "job" | "story" | "comment" | "poll" | "pollopt";

/** An item as the Firebase API returns it; every field except id/type is optional. */
export interface HnItem {
  id: number;
  type: HnItemType;
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number;
  parent?: number;
  kids?: number[];
  parts?: number[];
  poll?: number;
  deleted?: boolean;
  dead?: boolean;
  [extra: string]: unknown;
}

/** `orchestrator fetch` output, consumed by `hnformal render`. */
export interface DataJson {
  fetchedAt: number;
  top: number[];
  items: Record<string, HnItem>;
}

export interface Tier1Record {
  lakeBuild: "ok" | "fail";
  axioms: string[];
  selftest: "ok" | "fail";
}

export interface Tier2Record {
  vnu: number;
  axe: number;
  contrastMin: number;
  reflowWidth: number;
  csp: "ok" | "fail";
}

export interface Tier2Failure {
  check: "vnu" | "axe" | "contrast" | "reflow" | "csp" | "internal";
  page?: string;
  message: string;
}

export interface Tier2Report {
  ok: boolean;
  tier2: Tier2Record;
  failures: Tier2Failure[];
  pages: string[];
  checkedAt: number;
}

export interface JudgeResult {
  score: number | null;
  notes: string;
  costUsd: number;
  calls: number;
  screenshots?: Screenshots;
}

export interface Screenshots {
  index1280: string;
  index375: string;
  item1280: string;
}

export type CandidateStopReason = "passed" | "failed" | "cap-hit" | "killed" | "error";

export interface RoundLog {
  round: number;
  /** Stage that decided this round: "generate" (model-side failure) or a pipeline stage. */
  stage: string;
  ok: boolean;
  costUsd: number;
  calls: number;
  stopReason?: string | null;
  /** Output tokens (thinking included) of the generation call, when one was made. */
  outputTokens?: number;
  errorTail?: string;
  durationMs: number;
}

/** runs/<runId>/cand-<n>.json */
export interface CandidateRecord {
  runId: string;
  n: number;
  brief: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  rounds: number;
  tier1: string; // "ok" | "fail:<stage>" | "n/a"
  tier2: string; // "ok" | "fail:<check>" | "n/a"
  judge: number | null;
  judgeNotes?: string;
  lastError: string;
  costUsd: number;
  calls: number;
  stopReason: CandidateStopReason;
  roundLog: RoundLog[];
  tier1Detail?: Tier1Record;
  tier2Report?: Tier2Report;
  renderLean?: string;
  styleCss?: string;
  designNotes?: string;
  screenshots?: Screenshots;
  /**
   * Rendered DOM differs from the current site's (class attributes ignored).
   * false = CSS-only restyle. Absent when the check did not run.
   */
  domChanged?: boolean;
}

export interface PerCandidateSummary {
  n: number;
  rounds: number;
  tier1: string;
  tier2: string;
  judge: number | null;
  domChanged?: boolean | null;
  lastError: string;
}

/** runs/<runId>.json */
export interface RunRecord {
  runId: string;
  startedAt: number;
  finishedAt: number;
  candidates: number;
  passedTier1: number;
  passedTier2: number;
  released: string | null;
  costUsd: number;
  calls: number;
  stopReason: "released" | "no-passer" | "cap-hit" | "killed";
  perCandidate: PerCandidateSummary[];
}

/** releases/<id>/report.json */
export interface ReleaseReport {
  id: string;
  runId: string;
  specVersion: number;
  tier1: Tier1Record;
  tier2: Tier2Record;
  judge: { score: number | null; notes: string };
  model: string;
  repairRounds: number;
  costUsd: number;
  previousRelease: string | null;
  diffStat: string;
  candidate?: number;
  domChanged?: boolean;
  createdAt?: number;
}

/** runs/spend-YYYY-MM.json (shape defined by the orchestrator; not in CONTRACT). */
export interface SpendLedger {
  month: string;
  totalUsd: number;
  calls: number;
  runs: Record<
    string,
    { costUsd: number; calls: number; perCandidate: Record<string, { costUsd: number; calls: number }> }
  >;
  updatedAt: number;
}
