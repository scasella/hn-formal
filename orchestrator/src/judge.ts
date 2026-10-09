import path from "node:path";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import type { JudgeDetail, JudgeResult, Screenshots } from "./types.js";
import { judgeScreens, type JudgeImage } from "./anthropic.js";
import { Budget } from "./guardrails.js";
import { JUDGE_RUBRIC, type Brief } from "./prompts.js";
import { serveStatic } from "./server.js";
import { listHtml } from "./tier2.js";
import { ensureDir, envInt, log, writeJsonAtomic } from "./util.js";

/**
 * CONTRACT screenshots: index at 1280 and 375, one item page at 1280.
 * Clipped to the viewport (not fullPage): a 400-comment thread would exceed
 * the API's image limits.
 */
export async function takeScreenshots(siteDir: string, shotsDir: string, browser?: Browser): Promise<Screenshots> {
  await ensureDir(shotsDir);
  const pages = await listHtml(siteDir);
  const item = pages.find((p) => p.startsWith("item/"));
  const server = await serveStatic(siteDir);
  const b = browser ?? (await chromium.launch());
  const shots: Screenshots = {
    index1280: path.join(shotsDir, "index-1280.png"),
    index375: path.join(shotsDir, "index-375.png"),
    item1280: path.join(shotsDir, "item-1280.png"),
  };
  try {
    const shoot = async (rel: string, width: number, height: number, out: string) => {
      const ctx = await b.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      await page.goto(server.pageUrl(rel), { waitUntil: "load" });
      await page.screenshot({ path: out, fullPage: false });
      await ctx.close();
    };
    await shoot("index.html", 1280, 2000, shots.index1280);
    await shoot("index.html", 375, 2400, shots.index375);
    await shoot(item ?? "index.html", 1280, 2000, shots.item1280);
  } finally {
    if (!browser) await b.close();
    await server.close();
  }
  return shots;
}

/** Composite judge score (CONTRACT): adherence 40%, novelty 30%, craft 30%. */
export function compositeScore(d: JudgeDetail): number {
  const c = (x: number) => Math.max(0, Math.min(100, x));
  return Math.round(0.4 * c(d.adherence) + 0.3 * c(d.novelty) + 0.3 * c(d.craft));
}

export interface JudgeContext {
  brief?: Brief;
  /** Screenshot of the current live site's front page, the reference for novelty. */
  currentSitePng?: string;
}

/** Judge an already-screenshotted site. Never throws; never blocks. */
export async function judgeSite(shots: Screenshots, budget: Budget, ctx: JudgeContext = {}): Promise<JudgeResult> {
  try {
    const images: JudgeImage[] = [];
    if (ctx.currentSitePng && fs.existsSync(ctx.currentSitePng)) {
      images.push({ label: "THE CURRENT LIVE SITE, front page at 1280px (reference for novelty only; do not score it)", pngPath: ctx.currentSitePng });
    }
    images.push(
      { label: "CANDIDATE: index.html at 1280px wide", pngPath: shots.index1280 },
      { label: "CANDIDATE: index.html at 375px wide", pngPath: shots.index375 },
      { label: "CANDIDATE: an item (thread) page at 1280px wide", pngPath: shots.item1280 },
    );
    const preface = ctx.brief
      ? `Design brief for this candidate: "${ctx.brief.title}". ${ctx.brief.text} Required structure: ${ctx.brief.move}.`
      : undefined;
    const r = await judgeScreens(JUDGE_RUBRIC, images, budget, preface);
    if (!r.ok || !r.parsed) {
      return { score: null, notes: `judge failed: ${r.error ?? r.stopReason}`, costUsd: r.cost.usd, calls: 1, screenshots: shots };
    }
    const detail: JudgeDetail = { adherence: r.parsed.adherence, novelty: r.parsed.novelty, craft: r.parsed.craft };
    return { score: compositeScore(detail), detail, notes: r.parsed.notes, costUsd: r.cost.usd, calls: 1, screenshots: shots };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    log(`judge error (non-blocking): ${msg}`);
    return { score: null, notes: `judge failed: ${msg}`, costUsd: 0, calls: 0, screenshots: shots };
  }
}

export async function cmdJudge(args: { site: string; out: string; shots?: string; runId?: string }): Promise<JudgeResult> {
  const shotsDir = args.shots ?? path.join(path.dirname(path.resolve(args.out)), "shots");
  const shots = await takeScreenshots(args.site, shotsDir);
  const budget = await Budget.forCandidate(envInt("CANDIDATES", 16), "judge");
  const result = await judgeSite(shots, budget);
  await writeJsonAtomic(args.out, result);
  log(`judge: score=${result.score} cost=$${result.costUsd.toFixed(5)} -> ${args.out}`);
  return result;
}
