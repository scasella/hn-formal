import fsp from "node:fs/promises";
import path from "node:path";
import type { CandidateRecord, ReleaseReport } from "./types.js";
import { EDITABLE_FILES, fromRepo, repoRoot } from "./paths.js";
import { updateReadme } from "./readme.js";
import { diffStat, ensureDir, envInt, exists, gitShortSha, log, nowSec, readJson, readJsonOr, sha1Short, stamp, writeFileAtomic, writeJsonAtomic } from "./util.js";

/** `def version : Nat := N` in HnFormal/Spec.lean; SPEC_VERSION overrides. */
export async function specVersion(): Promise<number> {
  if (process.env.SPEC_VERSION) return envInt("SPEC_VERSION", 1);
  const p = fromRepo("HnFormal", "Spec.lean");
  if (exists(p)) {
    const m = (await fsp.readFile(p, "utf8")).match(/^def version : Nat := (\d+)/m);
    if (m) return Number(m[1]);
  }
  return 1;
}

export function releasesIndexPath(): string {
  return fromRepo("releases", "index.json");
}

export async function readReleasesIndex(): Promise<ReleaseReport[]> {
  return readJsonOr<ReleaseReport[]>(releasesIndexPath(), []);
}

/**
 * Create releases/<id>/ from a passed candidate, update releases/index.json,
 * and copy the two editable files into place. Does NOT commit.
 */
export async function releaseFromCandidate(cand: CandidateRecord): Promise<{ report: ReleaseReport; dir: string; paths: string[] }> {
  if (cand.stopReason !== "passed" || cand.tier1 !== "ok" || cand.tier2 !== "ok" || !cand.renderLean || !cand.styleCss) {
    throw new Error(`candidate ${cand.n} of run ${cand.runId} did not pass both tiers`);
  }
  if (!cand.tier1Detail || !cand.tier2Report) throw new Error("candidate record lacks tier1Detail/tier2Report");
  const root = repoRoot();
  const sha = (await gitShortSha(root)) ?? sha1Short(cand.renderLean + cand.styleCss);
  const id = `${stamp()}-${sha}`;
  const dir = fromRepo("releases", id);
  await ensureDir(dir);

  const renderDst = fromRepo(EDITABLE_FILES.renderLean);
  const cssDst = fromRepo(EDITABLE_FILES.styleCss);
  const newRender = path.join(dir, "Render.lean");
  const newCss = path.join(dir, "style.css");
  await writeFileAtomic(newRender, cand.renderLean);
  await writeFileAtomic(newCss, cand.styleCss);

  // diffStat against the files currently in place (the previous release).
  const parse = (s: string) => {
    const m = s.match(/^\+(\d+) -(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  const [a1, d1] = parse(await diffStat(exists(renderDst) ? renderDst : "/dev/null", newRender, root));
  const [a2, d2] = parse(await diffStat(exists(cssDst) ? cssDst : "/dev/null", newCss, root));
  const stat = `+${a1! + a2!} -${d1! + d2!}`;

  const index = await readReleasesIndex();
  const report: ReleaseReport = {
    id,
    runId: cand.runId,
    specVersion: await specVersion(),
    tier1: cand.tier1Detail,
    tier2: cand.tier2Report.tier2,
    judge: { score: cand.judge, notes: cand.judgeNotes ?? "" },
    model: cand.model,
    repairRounds: Math.max(0, cand.rounds - 1),
    costUsd: Math.round(cand.costUsd * 1e4) / 1e4,
    previousRelease: index[0]?.id ?? null,
    diffStat: stat,
    candidate: cand.n,
    brief: cand.brief,
    ...(cand.domChanged !== undefined ? { domChanged: cand.domChanged } : {}),
    createdAt: nowSec(),
  };
  await writeJsonAtomic(path.join(dir, "report.json"), report);

  const written = [newRender, newCss, path.join(dir, "report.json")];
  if (cand.screenshots) {
    for (const [key, name] of [
      ["index1280", "index-1280.png"],
      ["index375", "index-375.png"],
      ["item1280", "item-1280.png"],
    ] as const) {
      const raw = cand.screenshots[key];
      const src = path.isAbsolute(raw) ? raw : fromRepo(raw);
      if (exists(src)) {
        await fsp.copyFile(src, path.join(dir, name));
        written.push(path.join(dir, name));
      } else log(`warning: screenshot ${src} missing; release has no ${name}`);
    }
  } else log("warning: candidate has no screenshots; release has no pngs");

  // Copy the two editable files into place.
  await writeFileAtomic(renderDst, cand.renderLean);
  await writeFileAtomic(cssDst, cand.styleCss);
  written.push(renderDst, cssDst);

  index.unshift(report);
  await writeJsonAtomic(releasesIndexPath(), index);
  written.push(releasesIndexPath());
  if (await updateReadme(index)) written.push(fromRepo("README.md"));
  return { report, dir, paths: written };
}

export async function cmdRelease(args: { from: string }): Promise<ReleaseReport> {
  const from = path.isAbsolute(args.from) ? args.from : fromRepo(args.from);
  const cand = await readJson<CandidateRecord>(from);
  const { report, paths } = await releaseFromCandidate(cand);
  process.stdout.write(`release ${report.id}\n${paths.map((p) => `  ${p}`).join("\n")}\n`);
  return report;
}

export async function cmdRollback(releaseId: string): Promise<string[]> {
  const dir = fromRepo("releases", releaseId);
  const src1 = path.join(dir, "Render.lean");
  const src2 = path.join(dir, "style.css");
  if (!exists(src1) || !exists(src2)) throw new Error(`release ${releaseId} not found or incomplete at ${dir}`);
  const dst1 = fromRepo(EDITABLE_FILES.renderLean);
  const dst2 = fromRepo(EDITABLE_FILES.styleCss);
  await ensureDir(path.dirname(dst1));
  await ensureDir(path.dirname(dst2));
  await fsp.copyFile(src1, dst1);
  await fsp.copyFile(src2, dst2);
  const out = [dst1, dst2];
  // The README shows the generation in place, which is now this one.
  if (await updateReadme(await readReleasesIndex(), { currentId: releaseId })) out.push(fromRepo("README.md"));
  process.stdout.write(`rollback to ${releaseId}\n${out.map((p) => `  ${p}`).join("\n")}\n`);
  return out;
}
