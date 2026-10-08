import type { SpendLedger } from "./types.js";
import { fromRepo } from "./paths.js";
import { envInt, exists, log, monthKey, nowSec, readJsonOr, writeJsonAtomic } from "./util.js";

export class CapHit extends Error {
  constructor(
    public readonly cap: "run" | "month" | "calls",
    msg: string,
  ) {
    super(msg);
    this.name = "CapHit";
  }
}

/** CONTRACT: KILL_SWITCH at the repo root => every command exits 0 with "paused". */
export function killSwitchPath(): string {
  return fromRepo("KILL_SWITCH");
}

export function killSwitchPresent(): boolean {
  return exists(killSwitchPath());
}

/** Called at the start of every command. Exits the process when paused. */
export function checkKillSwitchOrExit(): void {
  if (killSwitchPresent()) {
    process.stdout.write("paused\n");
    process.exit(0);
  }
}

export interface Caps {
  runCapUsd: number;
  monthCapUsd: number;
  maxCalls: number;
}

export function caps(): Caps {
  return {
    runCapUsd: envInt("RUN_CAP_USD", 25),
    monthCapUsd: envInt("MONTH_CAP_USD", 400),
    maxCalls: envInt("MAX_CALLS", 200),
  };
}

export function spendLedgerPath(month = monthKey()): string {
  return fromRepo("runs", `spend-${month}.json`);
}

export async function readLedger(month = monthKey()): Promise<SpendLedger> {
  return readJsonOr<SpendLedger>(spendLedgerPath(month), {
    month,
    totalUsd: 0,
    calls: 0,
    runs: {},
    updatedAt: 0,
  });
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function recompute(ledger: SpendLedger): void {
  let total = 0;
  let calls = 0;
  for (const run of Object.values(ledger.runs)) {
    const perCand = Object.values(run.perCandidate);
    if (perCand.length > 0) {
      run.costUsd = round6(perCand.reduce((a, c) => a + c.costUsd, 0));
      run.calls = perCand.reduce((a, c) => a + c.calls, 0);
    }
    total += run.costUsd;
    calls += run.calls;
  }
  ledger.totalUsd = Math.round(total * 1e6) / 1e6;
  ledger.calls = calls;
  ledger.updatedAt = nowSec();
}

/**
 * Record one candidate's spend (idempotent: re-running candidate n of run r
 * replaces, never adds). The month total is recomputed from all entries.
 */
export async function recordCandidateSpend(
  runId: string,
  n: number,
  costUsd: number,
  calls: number,
  month = monthKey(),
): Promise<SpendLedger> {
  const ledger = await readLedger(month);
  const run = (ledger.runs[runId] ??= { costUsd: 0, calls: 0, perCandidate: {} });
  run.perCandidate[String(n)] = { costUsd: round6(costUsd), calls };
  recompute(ledger);
  await writeJsonAtomic(spendLedgerPath(month), ledger);
  return ledger;
}

/** Record a whole run's spend at once (aggregate; authoritative in CI). */
export async function recordRunSpend(
  runId: string,
  perCandidate: Array<{ n: number; costUsd: number; calls: number }>,
  month = monthKey(),
): Promise<SpendLedger> {
  const ledger = await readLedger(month);
  const run = (ledger.runs[runId] ??= { costUsd: 0, calls: 0, perCandidate: {} });
  for (const c of perCandidate) run.perCandidate[String(c.n)] = { costUsd: round6(c.costUsd), calls: c.calls };
  recompute(ledger);
  await writeJsonAtomic(spendLedgerPath(month), ledger);
  return ledger;
}

/**
 * Tracks spend for one process (one candidate, or a whole local run) and
 * throws CapHit when a cap is crossed. The month total is read from the
 * ledger at construction time plus whatever this process spends.
 */
export class Budget {
  costUsd = 0;
  calls = 0;
  constructor(
    public readonly limits: { capUsd: number; maxCalls: number; monthCapUsd: number },
    public readonly monthBaselineUsd: number,
    public readonly label: string,
  ) {}

  static async forCandidate(candidates: number, label: string): Promise<Budget> {
    const c = caps();
    const ledger = await readLedger();
    const share = Math.max(1, candidates);
    const b = new Budget(
      {
        capUsd: envInt("CANDIDATE_CAP_USD", c.runCapUsd / share),
        maxCalls: envInt("MAX_CALLS_PER_CANDIDATE", Math.max(1, Math.ceil(c.maxCalls / share))),
        monthCapUsd: c.monthCapUsd,
      },
      ledger.totalUsd,
      label,
    );
    b.assertMonth();
    return b;
  }

  assertMonth(): void {
    if (this.monthBaselineUsd + this.costUsd >= this.limits.monthCapUsd) {
      throw new CapHit(
        "month",
        `month cap hit: ${(this.monthBaselineUsd + this.costUsd).toFixed(4)} >= MONTH_CAP_USD ${this.limits.monthCapUsd}`,
      );
    }
  }

  /** Call before each API call. */
  beforeCall(): void {
    this.assertMonth();
    if (this.calls >= this.limits.maxCalls) {
      throw new CapHit("calls", `${this.label}: call cap hit (${this.calls} >= ${this.limits.maxCalls})`);
    }
    if (this.costUsd >= this.limits.capUsd) {
      throw new CapHit("run", `${this.label}: spend cap hit ($${this.costUsd.toFixed(4)} >= $${this.limits.capUsd})`);
    }
  }

  /** Call after each API call with the computed cost. */
  record(costUsd: number): void {
    this.calls++;
    this.costUsd += costUsd;
    log(`${this.label}: call ${this.calls} cost $${costUsd.toFixed(5)} total $${this.costUsd.toFixed(4)}`);
  }
}

/** Redact the API key from any string that might be logged. */
export function redact(s: string): string {
  const key = process.env.ANTHROPIC_API_KEY;
  let out = s;
  if (key && key.length > 8) out = out.split(key).join("[REDACTED]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}

