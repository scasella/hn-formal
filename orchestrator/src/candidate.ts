import Anthropic from "@anthropic-ai/sdk";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CandidateRecord, RoundLog, Screenshots, Tier1Record, Tier2Report } from "./types.js";
import { MOCK, MODEL, countPrefixTokens, generateCandidate, type CandidateOutput } from "./anthropic.js";
import { Budget, CapHit, killSwitchPresent, recordCandidateSpend, redact } from "./guardrails.js";
import { judgeSite, takeScreenshots } from "./judge.js";
import { EDITABLE_FILES, fromRepo, repoRoot } from "./paths.js";
import { ALLOWED_AXIOMS, briefBlock, briefFor, buildSystemPrefix, roundMessages, type RoundContext } from "./prompts.js";
import { firstFailingCheck, runTier2 } from "./tier2.js";
import { copyDir, ensureDir, envInt, envStr, exists, log, nowSec, runShell, tail, writeFileAtomic, writeJsonAtomic } from "./util.js";

export interface CandidateArgs {
  n: number;
  run: string;
  data: string;
  rounds: number;
  out: string;
  /** Number of candidates in the run (per-candidate cap = RUN_CAP_USD / candidates). */
  candidates: number;
}

export const HNFORMAL_BIN = envStr("HNFORMAL_BIN", "lake exe hnformal");

/**
 * Structure check (CONTRACT "Candidate protocol" step 7): for its first
 * STRUCTURE_ROUNDS rounds, a candidate whose rendered DOM equals the current
 * site's DOM (class attributes ignored) is sent back for a structural change;
 * the CSS-only pass is kept as a fallback. 0 disables the check. Off in mock
 * mode, where the fake renderer always produces the same fixture.
 */
export const STRUCTURE_ROUNDS = envInt("STRUCTURE_ROUNDS", MOCK ? 0 : 2);

/** HTML with class attributes removed (the renderer emits double-quoted attributes only). */
export function normalizeDom(html: string): string {
  return html.replace(/\sclass="[^"]*"/g, "");
}

export function sameDom(a: string, b: string): boolean {
  return normalizeDom(a) === normalizeDom(b);
}

/**
 * Did the candidate change the DOM, judged on index.html and the first item
 * page? A page missing on either side counts as a change.
 */
export async function domChangedVs(baseDir: string, outDir: string): Promise<boolean> {
  const pages = ["index.html"];
  const itemDir = path.join(outDir, "item");
  if (exists(itemDir)) {
    const items = (await fsp.readdir(itemDir)).filter((f) => f.endsWith(".html")).sort();
    if (items[0]) pages.push(path.join("item", items[0]));
  }
  for (const rel of pages) {
    const a = path.join(baseDir, rel);
    const b = path.join(outDir, rel);
    if (!exists(a) || !exists(b)) return true;
    if (!sameDom(await fsp.readFile(a, "utf8"), await fsp.readFile(b, "utf8"))) return true;
  }
  return false;
}

export function structureMessage(brief: string, structureRounds: number): string {
  return (
    "structure check: the candidate passed tier 1 and tier 2, but its rendered HTML is identical to the current site's HTML once class attributes are ignored. " +
    "It is a CSS-only restyle, which this loop accepts only as a last resort.\n\n" +
    `The design brief is: "${brief}".\n\n` +
    "Change the document structure to fit the brief: different element types or nesting for stories and comments (cards, table rows, timeline nodes, a masthead block, a definition list for metadata), a different order of the metadata fields, different grouping or sectioning of the page. " +
    "Keep every data-hn-story / data-hn-comment / data-hn marker, the about sentence, and the nav and footer strings, and re-prove render_ok for the new tree with the recipe.\n\n" +
    `Your CSS-only version has been kept as a fallback: if no structural attempt passes within the remaining rounds, the fallback ships. This check applies to the first ${structureRounds} round(s) only.`
  );
}

/** Everything a passing round produced; applied to the record now or kept as the fallback. */
interface PassState {
  files: CandidateOutput;
  tier1: Tier1Record;
  tier2: Tier2Report;
  judge: number | null;
  judgeNotes: string;
  screenshots?: Screenshots;
  domChanged?: boolean;
}

function applyPass(rec: CandidateRecord, p: PassState): void {
  rec.renderLean = p.files.renderLean;
  rec.styleCss = p.files.styleCss;
  rec.designNotes = p.files.designNotes;
  rec.tier1 = "ok";
  rec.tier1Detail = p.tier1;
  rec.tier2 = "ok";
  rec.tier2Report = p.tier2;
  rec.judge = p.judge;
  rec.judgeNotes = p.judgeNotes;
  if (p.screenshots) rec.screenshots = p.screenshots;
  if (p.domChanged !== undefined) rec.domChanged = p.domChanged;
  rec.stopReason = "passed";
  rec.lastError = "";
}

/** Built-in mirror of scripts/css-lint.sh for when the script is absent. */
export function cssLint(css: string): string[] {
  const problems: string[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\b/i.test(stripped)) problems.push("@import is not allowed");
  for (const m of stripped.matchAll(/content\s*:\s*([^;}]*)/gi)) {
    const v = m[1]!.trim();
    if (v === "" || /^(none|normal|""|'')$/.test(v)) continue;
    if (/["'][^"']+["']/.test(v)) problems.push(`non-empty content: string not allowed: content: ${v}`);
    else if (!/^(open-quote|close-quote|no-open-quote|no-close-quote)$/.test(v)) problems.push(`content: value not allowed: ${v}`);
  }
  for (const m of stripped.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const ref = m[2]!.trim();
    if (!ref.startsWith("/hn-formal/fonts/")) problems.push(`url() outside /hn-formal/fonts/ not allowed: ${ref}`);
  }
  return problems;
}

function stripFence(s: string): string {
  const m = s.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! + "\n" : s;
}

interface StageResult {
  ok: boolean;
  output: string;
}

export interface Pipeline {
  workdir: string;
  dataRel: string;
  outDir: string;
}

const EXCLUDE_DIRS = new Set([".lake", "node_modules", ".git", "out", "runs", "releases", ".cache"]);

/** Copy the working tree (minus build/cache dirs) into a scratch dir. */
export async function makeWorkdir(runId: string, n: number): Promise<string> {
  const base = process.env.CANDIDATE_WORKDIR
    ? path.resolve(process.env.CANDIDATE_WORKDIR)
    : await fsp.mkdtemp(path.join(os.tmpdir(), `hnformal-${runId}-cand${n}-`));
  await ensureDir(base);
  const root = repoRoot();
  const includeLake = process.env.COPY_LAKE === "1";
  await fsp.cp(root, base, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      for (const seg of rel.split(path.sep)) {
        if (seg === ".lake" && includeLake) continue;
        if (EXCLUDE_DIRS.has(seg)) return false;
      }
      return true;
    },
  });
  return base;
}

function stageTimeoutMs(stage: string): number {
  const def = stage === "lake-build" ? 3600 : 900;
  return envInt(`${stage.toUpperCase().replace(/-/g, "_")}_TIMEOUT_SECONDS`, envInt("STAGE_TIMEOUT_SECONDS", def)) * 1000;
}

async function shellStage(stage: string, cmd: string, cwd: string): Promise<StageResult> {
  log(`[${stage}] ${cmd}`);
  const r = await runShell(cmd, { cwd, timeoutMs: stageTimeoutMs(stage), env: { HNFORMAL_BIN } });
  const output = `$ ${cmd}\n${r.stdout}${r.stderr ? "\n--- stderr ---\n" + r.stderr : ""}` + (r.timedOut ? "\n[timed out]" : "") + `\n[exit ${r.code}]`;
  return { ok: r.code === 0 && !r.timedOut, output };
}

function renderCommand(p: Pipeline, outDir: string): string {
  return envStr("RENDER_CMD", `${HNFORMAL_BIN} render {data} {out}`)
    .replace("{data}", p.dataRel)
    .replace("{out}", path.relative(p.workdir, outDir) || ".");
}

/**
 * Render the files currently in place (before the candidate's) into
 * <workdir>/out-base for the structure check. Null if that fails; the check
 * is then skipped for this candidate.
 */
export async function renderBaseline(p: Pipeline): Promise<string | null> {
  const dir = path.join(p.workdir, "out-base");
  await fsp.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  const r = await shellStage("render-base", renderCommand(p, dir), p.workdir);
  if (!r.ok || !exists(path.join(dir, "index.html"))) {
    log(`baseline render failed; structure check skipped\n${tail(r.output, 1500)}`);
    return null;
  }
  return dir;
}

/** Steps 2-6 of the CONTRACT candidate protocol. Returns the first failing stage. */
export async function runTier1(p: Pipeline): Promise<{ failedStage: string | null; output: string; tier1: Tier1Record }> {
  const tier1: Tier1Record = { lakeBuild: "fail", axioms: [], selftest: "fail" };
  // 2. css-lint
  const cssPath = path.join(p.workdir, EDITABLE_FILES.styleCss);
  let lint: StageResult;
  if (process.env.CSS_LINT_CMD) {
    lint = await shellStage("css-lint", process.env.CSS_LINT_CMD, p.workdir);
  } else if (exists(path.join(p.workdir, "scripts/css-lint.sh"))) {
    lint = await shellStage("css-lint", `bash scripts/css-lint.sh ${EDITABLE_FILES.styleCss}`, p.workdir);
  } else {
    const problems = cssLint(await fsp.readFile(cssPath, "utf8"));
    lint = { ok: problems.length === 0, output: problems.length ? `css-lint (built-in):\n${problems.join("\n")}` : "css-lint (built-in): ok" };
  }
  if (!lint.ok) return { failedStage: "css-lint", output: lint.output, tier1 };
  // Belt and braces: the built-in lint runs even when the script passed.
  const builtin = cssLint(await fsp.readFile(cssPath, "utf8"));
  if (builtin.length) return { failedStage: "css-lint", output: `css-lint (built-in):\n${builtin.join("\n")}`, tier1 };

  // 3. lake build
  const build = await shellStage("lake-build", envStr("LAKE_BUILD_CMD", "lake build"), p.workdir);
  if (!build.ok) return { failedStage: "lake-build", output: build.output, tier1 };
  tier1.lakeBuild = "ok";

  // 4. axiom check
  let axCmd = process.env.AXIOM_CHECK_CMD;
  if (!axCmd) {
    if (exists(path.join(p.workdir, "scripts/axiom-check.sh"))) axCmd = "bash scripts/axiom-check.sh";
    else return { failedStage: "axioms", output: "scripts/axiom-check.sh is missing; set AXIOM_CHECK_CMD", tier1 };
  }
  const ax = await shellStage("axioms", axCmd, p.workdir);
  const m = ax.output.match(/depends on axioms:\s*\[([^\]]*)\]/);
  tier1.axioms = m
    ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean)
    : ax.ok
      ? [...ALLOWED_AXIOMS]
      : [];
  if (!ax.ok) return { failedStage: "axioms", output: ax.output, tier1 };
  if (tier1.axioms.some((a) => !ALLOWED_AXIOMS.includes(a))) {
    return { failedStage: "axioms", output: `axiom set ${JSON.stringify(tier1.axioms)} is not a subset of ${JSON.stringify(ALLOWED_AXIOMS)}\n${ax.output}`, tier1 };
  }

  // 5. selftest
  const st = await shellStage("selftest", envStr("SELFTEST_CMD", `${HNFORMAL_BIN} selftest`), p.workdir);
  if (!st.ok) return { failedStage: "selftest", output: st.output, tier1 };
  tier1.selftest = "ok";

  // 6. render
  await fsp.rm(p.outDir, { recursive: true, force: true });
  await ensureDir(p.outDir);
  const rn = await shellStage("render", renderCommand(p, p.outDir), p.workdir);
  if (!rn.ok) return { failedStage: "render", output: rn.output, tier1 };
  if (!exists(path.join(p.outDir, "index.html"))) return { failedStage: "render", output: `render exited 0 but wrote no index.html\n${rn.output}`, tier1 };
  // The site root also needs the stylesheet and fonts (render writes html only).
  await fsp.copyFile(cssPath, path.join(p.outDir, "style.css"));
  const fonts = path.join(p.workdir, "site/fonts");
  if (exists(fonts)) await copyDir(fonts, path.join(p.outDir, "fonts"));
  return { failedStage: null, output: rn.output, tier1 };
}

function formatTier2(r: Tier2Report): string {
  const lines = [`tier2 summary: ${JSON.stringify(r.tier2)}`];
  for (const f of r.failures.slice(0, 80)) lines.push(`[${f.check}]${f.page ? ` ${f.page}:` : ""} ${f.message}`);
  if (r.failures.length > 80) lines.push(`... ${r.failures.length - 80} more`);
  return lines.join("\n");
}

export async function cmdCandidate(args: CandidateArgs): Promise<CandidateRecord> {
  const startedAt = nowSec();
  const outPath = path.isAbsolute(args.out) ? args.out : fromRepo(args.out);
  const artifactDir = path.join(path.dirname(outPath), `cand-${args.n}`);
  await ensureDir(artifactDir);
  const brief = briefFor(args.n);
  const rec: CandidateRecord = {
    runId: args.run,
    n: args.n,
    brief,
    model: MODEL,
    startedAt,
    finishedAt: 0,
    rounds: 0,
    tier1: "n/a",
    tier2: "n/a",
    judge: null,
    lastError: "",
    costUsd: 0,
    calls: 0,
    stopReason: "failed",
    roundLog: [],
  };
  const save = async () => {
    rec.finishedAt = nowSec();
    await writeJsonAtomic(outPath, rec);
  };

  let budget: Budget;
  try {
    budget = await Budget.forCandidate(args.candidates, `cand-${args.n}`);
  } catch (e) {
    if (!(e instanceof CapHit)) throw e;
    // Month cap already exhausted before the first call: record and stop.
    rec.stopReason = "cap-hit";
    rec.lastError = e.message;
    await save();
    log(`cand-${args.n}: ${e.message}`);
    return rec;
  }
  const { system, found } = await buildSystemPrefix();
  log(`cand-${args.n}: brief="${brief}" library files=${found.join(",") || "(none)"}`);
  await countPrefixTokens(system);

  const dataAbs = path.isAbsolute(args.data) ? args.data : fromRepo(args.data);
  if (!exists(dataAbs)) throw new Error(`data file not found: ${dataAbs}`);
  const workdir = await makeWorkdir(args.run, args.n);
  const pipeline: Pipeline = { workdir, dataRel: "data/latest.json", outDir: path.join(workdir, "out") };
  await ensureDir(path.join(workdir, "data"));
  await fsp.copyFile(dataAbs, path.join(workdir, pipeline.dataRel));
  log(`cand-${args.n}: workdir ${workdir}`);
  const baseline = STRUCTURE_ROUNDS > 0 && args.rounds > 1 ? await renderBaseline(pipeline) : null;
  /** A CSS-only pass held back by the structure check; ships if nothing better passes. */
  let fallback: PassState | null = null;

  let previous: CandidateOutput | undefined;
  let failure: RoundContext["failure"];

  try {
    for (let round = 1; round <= args.rounds; round++) {
      if (killSwitchPresent()) {
        rec.stopReason = "killed";
        rec.lastError = "KILL_SWITCH present";
        break;
      }
      const t0 = Date.now();
      rec.rounds = round;
      const roundLog: RoundLog = { round, stage: "generate", ok: false, costUsd: 0, calls: 0, durationMs: 0 };
      rec.roundLog.push(roundLog);
      const callsBefore = budget.calls;
      const costBefore = budget.costUsd;

      let gen: Awaited<ReturnType<typeof generateCandidate>>;
      try {
        gen = await generateCandidate([...system, briefBlock(brief)], roundMessages({ round, maxRounds: args.rounds, previous, failure }), budget);
      } catch (e) {
        // Transport/API errors after the SDK's retries cost one round, not the candidate.
        if (e instanceof CapHit || !(e instanceof Anthropic.APIError)) throw e;
        gen = {
          ok: false,
          parsed: null,
          stopReason: null,
          error: `API error ${e.status ?? ""}: ${redact(e.message)}`,
          cost: { promptTokens: 0, tier: "low", usd: 0 },
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      }
      roundLog.calls = budget.calls - callsBefore;
      roundLog.costUsd = budget.costUsd - costBefore;
      roundLog.stopReason = gen.stopReason;
      if (gen.usage.output_tokens) roundLog.outputTokens = gen.usage.output_tokens;
      rec.costUsd = budget.costUsd;
      rec.calls = budget.calls;

      if (!gen.ok || !gen.parsed) {
        roundLog.errorTail = gen.error ?? "generation failed";
        rec.lastError = roundLog.errorTail;
        failure = { stage: "generate", output: `${gen.error}\n(The previous files below are from the last successful generation, if any.)` };
        roundLog.durationMs = Date.now() - t0;
        await save();
        continue;
      }
      const files: CandidateOutput = {
        renderLean: stripFence(gen.parsed.renderLean),
        styleCss: stripFence(gen.parsed.styleCss),
        designNotes: gen.parsed.designNotes,
      };
      previous = files;
      await writeFileAtomic(path.join(workdir, EDITABLE_FILES.renderLean), files.renderLean);
      await writeFileAtomic(path.join(workdir, EDITABLE_FILES.styleCss), files.styleCss);
      await writeFileAtomic(path.join(artifactDir, "Render.lean"), files.renderLean);
      await writeFileAtomic(path.join(artifactDir, "style.css"), files.styleCss);

      const t1 = await runTier1(pipeline);
      rec.tier1Detail = t1.tier1;
      if (t1.failedStage) {
        rec.tier1 = `fail:${t1.failedStage}`;
        rec.tier2 = "n/a";
        roundLog.stage = t1.failedStage;
        roundLog.errorTail = tail(t1.output, 4000);
        rec.lastError = roundLog.errorTail;
        failure = { stage: t1.failedStage, output: t1.output };
        roundLog.durationMs = Date.now() - t0;
        log(`cand-${args.n} round ${round}: tier1 failed at ${t1.failedStage}`);
        await save();
        continue;
      }
      rec.tier1 = "ok";

      const t2 = await runTier2({ siteDir: pipeline.outDir });
      rec.tier2Report = t2;
      await writeJsonAtomic(path.join(artifactDir, "tier2.json"), t2);
      if (!t2.ok) {
        const check = firstFailingCheck(t2) ?? "unknown";
        rec.tier2 = `fail:${check}`;
        roundLog.stage = `tier2:${check}`;
        roundLog.errorTail = tail(formatTier2(t2), 4000);
        rec.lastError = roundLog.errorTail;
        failure = { stage: `tier2:${check}`, output: formatTier2(t2) };
        roundLog.durationMs = Date.now() - t0;
        log(`cand-${args.n} round ${round}: tier2 failed at ${check}`);
        await save();
        continue;
      }
      rec.tier2 = "ok";

      // Passed both tiers: screenshot and judge (non-blocking), then either
      // finish or, for a CSS-only restyle in the first rounds, hold the pass
      // as the fallback and ask for structure (CONTRACT step 7).
      const pass: PassState = { files, tier1: t1.tier1, tier2: t2, judge: null, judgeNotes: "" };
      try {
        const shots = await takeScreenshots(pipeline.outDir, artifactDir);
        // Stored relative to the repo root so the record survives moving to
        // another runner (the aggregate job downloads cand-<n>/** as artifacts).
        const rel = (p: string) => path.relative(repoRoot(), p);
        pass.screenshots = { index1280: rel(shots.index1280), index375: rel(shots.index375), item1280: rel(shots.item1280) };
        const j = await judgeSite(shots, budget);
        pass.judge = j.score;
        pass.judgeNotes = j.notes;
      } catch (e) {
        if (e instanceof CapHit) log(`judge skipped: ${e.message}`);
        else log(`screenshots/judge failed (non-blocking): ${String((e as Error).message ?? e)}`);
      }
      roundLog.costUsd = budget.costUsd - costBefore;
      roundLog.calls = budget.calls - callsBefore;
      rec.costUsd = budget.costUsd;
      rec.calls = budget.calls;

      if (baseline) pass.domChanged = await domChangedVs(baseline, pipeline.outDir);
      if (pass.domChanged === false && round <= STRUCTURE_ROUNDS && round < args.rounds) {
        fallback = pass;
        const msg = structureMessage(brief, STRUCTURE_ROUNDS);
        roundLog.stage = "structure";
        roundLog.errorTail = msg;
        rec.lastError = msg;
        failure = { stage: "structure", output: msg };
        roundLog.durationMs = Date.now() - t0;
        log(`cand-${args.n} round ${round}: passed both tiers with an unchanged DOM (judge ${pass.judge}); held as fallback, asking for structure`);
        await save();
        continue;
      }
      applyPass(rec, pass);
      roundLog.stage = "passed";
      roundLog.ok = true;
      roundLog.durationMs = Date.now() - t0;
      log(`cand-${args.n} round ${round}: PASSED (judge ${rec.judge}${pass.domChanged === false ? ", CSS-only" : ""})`);
      await save();
      break;
    }
  } catch (e) {
    if (e instanceof CapHit) {
      rec.stopReason = "cap-hit";
      rec.lastError = e.message;
      log(`cand-${args.n}: ${e.message}`);
    } else {
      rec.stopReason = "error";
      rec.lastError = String((e as Error).stack ?? e);
      log(`cand-${args.n}: error: ${rec.lastError}`);
    }
  } finally {
    if (fallback && rec.stopReason !== "passed" && rec.stopReason !== "killed") {
      // Rounds ran out (or the cap hit, or a later round crashed) without a
      // structural pass: the CSS-only pass ships, and its files replace the
      // later rounds' artifacts. Its screenshots are already in artifactDir
      // (later rounds only screenshot when they pass, which would have ended
      // the loop).
      applyPass(rec, fallback);
      await writeFileAtomic(path.join(artifactDir, "Render.lean"), fallback.files.renderLean);
      await writeFileAtomic(path.join(artifactDir, "style.css"), fallback.files.styleCss);
      await writeJsonAtomic(path.join(artifactDir, "tier2.json"), fallback.tier2);
      log(`cand-${args.n}: no structural pass; restored the CSS-only fallback (judge ${rec.judge})`);
    }
    rec.costUsd = budget.costUsd;
    rec.calls = budget.calls;
    await save();
    await recordCandidateSpend(args.run, args.n, rec.costUsd, rec.calls);
    if (!process.env.CANDIDATE_WORKDIR && process.env.KEEP_WORKDIR !== "1") {
      await fsp.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  log(`cand-${args.n}: ${rec.stopReason} after ${rec.rounds} round(s), $${rec.costUsd.toFixed(4)}, ${rec.calls} calls -> ${outPath}`);
  return rec;
}
