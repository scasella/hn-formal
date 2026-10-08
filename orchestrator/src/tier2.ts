import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type { Tier2Failure, Tier2Report } from "./types.js";
import { cacheDir } from "./paths.js";
import { serveStatic } from "./server.js";
import { ensureDir, envStr, exists, log, nowSec, runShell, writeJsonAtomic } from "./util.js";

const BROWSER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser");
const CONTRAST_JS = fs.readFileSync(path.join(BROWSER_DIR, "contrast.js"), "utf8");
const CSP_JS = fs.readFileSync(path.join(BROWSER_DIR, "csp.js"), "utf8");

interface ContrastResult {
  checked: number;
  min: number | null;
  failures: Array<{ ratio: number; required: number; text: string; selector: string; fg: string; bg: string; unknownBg?: boolean }>;
}
interface CspResult {
  problems: string[];
  warnings: string[];
}

const VNU_URL = envStr("VNU_URL", "https://github.com/validator/validator/releases/download/latest/vnu.jar");

export async function ensureVnuJar(): Promise<string> {
  const jar = process.env.VNU_JAR ?? path.join(cacheDir(), "vnu.jar");
  if (exists(jar)) return jar;
  await ensureDir(path.dirname(jar));
  log(`downloading vnu.jar from ${VNU_URL} -> ${jar}`);
  const res = await fetch(VNU_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`vnu.jar download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`vnu.jar download looks wrong (${buf.length} bytes)`);
  const tmp = `${jar}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, jar);
  return jar;
}

export async function listHtml(siteDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), r);
      else if (ent.name.endsWith(".html")) out.push(r);
    }
  }
  await walk(siteDir, "");
  return out.sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
}

interface VnuMessage {
  type: string;
  subType?: string;
  url?: string;
  lastLine?: number;
  message: string;
}

export async function runVnu(siteDir: string, pages: string[]): Promise<{ errors: number; failures: Tier2Failure[] }> {
  const jar = await ensureVnuJar();
  const files = pages.map((p) => JSON.stringify(path.join(siteDir, p))).join(" ");
  const r = await runShell(`java -jar ${JSON.stringify(jar)} --format json --errors-only --exit-zero-always ${files}`, {
    cwd: siteDir,
    timeoutMs: 10 * 60 * 1000,
  });
  const raw = [r.stdout, r.stderr].find((s) => s.trim().startsWith("{")) ?? "";
  let msgs: VnuMessage[] = [];
  try {
    msgs = (JSON.parse(raw) as { messages: VnuMessage[] }).messages ?? [];
  } catch {
    return {
      errors: 1,
      failures: [{ check: "vnu", message: `vnu did not produce JSON (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 2000)}` }],
    };
  }
  const errs = msgs.filter((m) => m.type === "error");
  return {
    errors: errs.length,
    failures: errs.slice(0, 50).map((m) => ({
      check: "vnu",
      page: m.url ? path.relative(siteDir, m.url.replace(/^file:/, "")) : undefined,
      message: `${m.message}${m.lastLine ? ` (line ${m.lastLine})` : ""}`,
    })),
  };
}



export interface Tier2Options {
  siteDir: string;
  /** Item pages to run axe/contrast/reflow on (CONTRACT: 3). */
  itemPages?: number;
  allPages?: boolean;
  browser?: Browser;
}

export async function runTier2(opts: Tier2Options): Promise<Tier2Report> {
  const siteDir = path.resolve(opts.siteDir);
  const failures: Tier2Failure[] = [];
  const pages = await listHtml(siteDir);
  if (!pages.includes("index.html")) {
    return {
      ok: false,
      tier2: { vnu: 1, axe: 0, contrastMin: 0, reflowWidth: 0, csp: "fail" },
      failures: [{ check: "internal", message: "index.html missing" }],
      pages,
      checkedAt: nowSec(),
    };
  }
  const itemPages = pages.filter((p) => p.startsWith("item/"));
  const sample = opts.allPages ? pages : ["index.html", ...itemPages.slice(0, opts.itemPages ?? 3)];

  // 1. vnu on every html file.
  const vnu = await runVnu(siteDir, pages);
  failures.push(...vnu.failures);

  // 2-5. Browser checks.
  const server = await serveStatic(siteDir);
  const browser = opts.browser ?? (await chromium.launch());
  let axeCount = 0;
  let contrastMin: number | null = null;
  let contrastFailures = 0;
  let reflowWidth = 0;
  let cspOk = true;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const narrow = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: false });
    for (const rel of sample) {
      const url = `${server.url}/${rel}`;
      const page: Page = await ctx.newPage();
      const resp = await page.goto(url, { waitUntil: "load" });
      if (!resp || !resp.ok()) {
        failures.push({ check: "internal", page: rel, message: `HTTP ${resp?.status()} loading ${rel}` });
        await page.close();
        continue;
      }
      // axe
      const axe = await new AxeBuilder({ page }).analyze();
      for (const v of axe.violations) {
        if (v.impact === "serious" || v.impact === "critical") {
          axeCount++;
          failures.push({
            check: "axe",
            page: rel,
            message: `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s); e.g. ${v.nodes[0]?.target.join(" ") ?? "?"})`,
          });
        }
      }
      // contrast
      const c = (await page.evaluate(CONTRAST_JS)) as ContrastResult;
      if (c.min !== null) contrastMin = contrastMin === null ? c.min : Math.min(contrastMin, c.min);
      for (const f of c.failures) {
        contrastFailures++;
        failures.push({
          check: "contrast",
          page: rel,
          message: f.unknownBg
            ? `cannot compute contrast over background-image at ${f.selector} ("${f.text}")`
            : `${f.ratio}:1 < ${f.required}:1 at ${f.selector} ("${f.text}") fg ${f.fg} on ${f.bg}`,
        });
      }
      // csp
      const csp = (await page.evaluate(CSP_JS)) as CspResult;
      if (csp.problems.length) {
        cspOk = false;
        for (const p of csp.problems) failures.push({ check: "csp", page: rel, message: p });
      }
      for (const w of csp.warnings.slice(0, 5)) log(`csp warning (${rel}): ${w}`);
      await page.close();
      // reflow
      const np = await narrow.newPage();
      await np.goto(url, { waitUntil: "load" });
      const w = await np.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      reflowWidth = Math.max(reflowWidth, w);
      if (w > 375) failures.push({ check: "reflow", page: rel, message: `scrollWidth ${w} > 375 at a 375px viewport` });
      await np.close();
    }
    await ctx.close();
    await narrow.close();
  } finally {
    if (!opts.browser) await browser.close();
    await server.close();
  }
  const tier2 = {
    vnu: vnu.errors,
    axe: axeCount,
    contrastMin: contrastMin ?? 0,
    reflowWidth,
    csp: cspOk ? ("ok" as const) : ("fail" as const),
  };
  const ok = tier2.vnu === 0 && tier2.axe === 0 && contrastFailures === 0 && reflowWidth <= 375 && cspOk && !failures.some((f) => f.check === "internal");
  return { ok, tier2, failures, pages: sample, checkedAt: nowSec() };
}

/** Name of the first failing check, in CONTRACT order. */
export function firstFailingCheck(r: Tier2Report): string | null {
  if (r.ok) return null;
  for (const c of ["vnu", "axe", "contrast", "reflow", "csp", "internal"] as const) {
    if (r.failures.some((f) => f.check === c)) return c;
  }
  return "unknown";
}

export async function cmdTier2(args: { site: string; out: string; allPages?: boolean }): Promise<Tier2Report> {
  const report = await runTier2({ siteDir: args.site, allPages: args.allPages });
  await writeJsonAtomic(args.out, report);
  log(`tier2: ${report.ok ? "ok" : "FAIL"} vnu=${report.tier2.vnu} axe=${report.tier2.axe} contrastMin=${report.tier2.contrastMin} reflow=${report.tier2.reflowWidth} csp=${report.tier2.csp} (${report.failures.length} failures) -> ${args.out}`);
  return report;
}
