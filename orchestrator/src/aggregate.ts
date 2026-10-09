import fsp from "node:fs/promises";
import path from "node:path";
import type { CandidateRecord, RunRecord } from "./types.js";
import { recordRunSpend } from "./guardrails.js";
import { fromRepo } from "./paths.js";
import { releaseFromCandidate } from "./release.js";
import { log, nowSec, readJson, readJsonOr, writeJsonAtomic } from "./util.js";

export interface RunIndexEntry {
  runId: string;
  startedAt: number;
  finishedAt: number;
  candidates: number;
  passedTier1: number;
  passedTier2: number;
  released: string | null;
  stopReason: RunRecord["stopReason"];
  costUsd: number;
  calls: number;
}

export async function readCandidates(dir: string): Promise<CandidateRecord[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: CandidateRecord[] = [];
  for (const name of names.filter((n) => /^cand-\d+\.json$/.test(n)).sort()) {
    try {
      out.push(await readJson<CandidateRecord>(path.join(dir, name)));
    } catch (e) {
      log(`skipping unreadable ${name}: ${String((e as Error).message ?? e)}`);
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

export function pickWinner(cands: CandidateRecord[]): CandidateRecord | null {
  const passers = cands.filter((c) => c.stopReason === "passed" && c.tier1 === "ok" && c.tier2 === "ok" && c.renderLean && c.styleCss);
  if (!passers.length) return null;
  // Highest judge score; ties go to a changed DOM over a CSS-only restyle; then lowest n.
  passers.sort((a, b) => (b.judge ?? -1) - (a.judge ?? -1) || Number(b.domChanged === true) - Number(a.domChanged === true) || a.n - b.n);
  return passers[0]!;
}

export function buildRunRecord(runId: string, cands: CandidateRecord[], released: string | null): RunRecord {
  const stopReason: RunRecord["stopReason"] = released
    ? "released"
    : cands.some((c) => c.stopReason === "cap-hit")
      ? "cap-hit"
      : cands.some((c) => c.stopReason === "killed")
        ? "killed"
        : "no-passer";
  return {
    runId,
    startedAt: cands.length ? Math.min(...cands.map((c) => c.startedAt)) : nowSec(),
    finishedAt: nowSec(),
    candidates: cands.length,
    passedTier1: cands.filter((c) => c.tier1 === "ok").length,
    passedTier2: cands.filter((c) => c.tier2 === "ok").length,
    released,
    costUsd: Math.round(cands.reduce((a, c) => a + c.costUsd, 0) * 1e4) / 1e4,
    calls: cands.reduce((a, c) => a + c.calls, 0),
    stopReason,
    perCandidate: cands.map((c) => ({
      n: c.n,
      rounds: c.rounds,
      tier1: c.tier1,
      tier2: c.tier2,
      judge: c.judge,
      domChanged: c.domChanged ?? null,
      lastError: c.lastError.slice(0, 2000),
    })),
  };
}

export async function cmdAggregate(args: { run: string; dir?: string; noRelease?: boolean }): Promise<RunRecord> {
  const dir = args.dir ? (path.isAbsolute(args.dir) ? args.dir : fromRepo(args.dir)) : fromRepo("runs", args.run);
  const cands = await readCandidates(dir);
  if (!cands.length) log(`warning: no cand-*.json in ${dir}`);
  await recordRunSpend(
    args.run,
    cands.map((c) => ({ n: c.n, costUsd: c.costUsd, calls: c.calls })),
  );
  let released: string | null = null;
  const winner = pickWinner(cands);
  if (winner && !args.noRelease) {
    const { report, paths } = await releaseFromCandidate(winner);
    released = report.id;
    process.stdout.write(`release ${report.id} (candidate ${winner.n}, judge ${winner.judge})\n${paths.map((p) => `  ${p}`).join("\n")}\n`);
  } else if (winner) {
    log(`winner is candidate ${winner.n} (judge ${winner.judge}); --no-release set`);
  }
  const record = buildRunRecord(args.run, cands, released);
  const recPath = fromRepo("runs", `${args.run}.json`);
  await writeJsonAtomic(recPath, record);

  const indexPath = fromRepo("runs", "index.json");
  const index = (await readJsonOr<RunIndexEntry[]>(indexPath, [])).filter((e) => e.runId !== args.run);
  const { perCandidate: _pc, ...summary } = record;
  index.unshift(summary);
  index.sort((a, b) => b.runId.localeCompare(a.runId));
  await writeJsonAtomic(indexPath, index);

  log(`aggregate: ${record.stopReason} candidates=${record.candidates} tier1=${record.passedTier1} tier2=${record.passedTier2} cost=$${record.costUsd} calls=${record.calls} -> ${recPath}`);
  return record;
}
