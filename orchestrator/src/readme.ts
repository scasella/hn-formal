import fsp from "node:fs/promises";
import type { ReleaseReport } from "./types.js";
import { fromRepo } from "./paths.js";
import { envStr, exists, log, writeFileAtomic } from "./util.js";

/** Public URL of the deployed site (trailing slash). */
export const SITE_URL = envStr("SITE_URL", "https://scasella.github.io/hn-formal/");
export const README_START = "<!-- generation:start -->";
export const README_END = "<!-- generation:end -->";
const PREVIOUS = 6;

function fmtDate(id: string): string {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : id;
}

/**
 * The README's generation section: the current release's 1280px screenshot
 * linking to the live site, its facts, and thumbnails of the previous few.
 * Deterministic text only (ids, numbers, the brief from the fixed list);
 * judge notes are model output and stay out of the README.
 */
export function renderGenerationSection(reports: ReleaseReport[], currentId?: string): string {
  const cur = (currentId ? reports.find((r) => r.id === currentId) : undefined) ?? reports[0];
  if (!cur) return `${README_START}\n_No generation released yet._\n${README_END}`;
  const lines: string[] = [README_START, "## Current generation", ""];
  lines.push(`[![Front page of generation ${cur.id} at 1280px](releases/${cur.id}/index-1280.png)](${SITE_URL})`, "");
  const facts = [
    `Generation \`${cur.id}\` (${fmtDate(cur.id)})`,
    cur.brief ? `brief "${cur.brief.replace(/[<>]/g, "")}"` : null,
    cur.judge.score !== null ? `judge ${cur.judge.score}/100` : null,
    `spec v${cur.specVersion}`,
    cur.domChanged === true ? "new DOM" : cur.domChanged === false ? "CSS-only" : null,
    `${cur.repairRounds} repair round${cur.repairRounds === 1 ? "" : "s"}`,
    `$${cur.costUsd.toFixed(2)}`,
    `[report](releases/${cur.id}/report.json)`,
  ].filter((x): x is string => x !== null);
  lines.push(facts.join(" · "), "");
  const prev = reports.filter((r) => r.id !== cur.id).slice(0, PREVIOUS);
  if (prev.length) {
    lines.push("### Previous generations", "", "<p>");
    for (const r of prev) {
      const alt = `Generation ${r.id}${r.judge.score !== null ? `, judge ${r.judge.score}` : ""}`;
      lines.push(`<a href="releases/${r.id}/"><img src="releases/${r.id}/index-375.png" width="120" alt="${alt}"></a>`);
    }
    lines.push("</p>", "");
  }
  lines.push(
    `Every generation, with its proof, stylesheet, report and screenshots, is under [releases/](releases/). Run history is on the [dashboard](${SITE_URL}loop/). This section is rewritten by the release step; see CONTRACT.md.`,
    README_END,
  );
  return lines.join("\n");
}

/** Rewrite the marked section. Returns whether the file changed. */
export async function updateReadme(reports: ReleaseReport[], opts: { currentId?: string; readmePath?: string } = {}): Promise<boolean> {
  const p = opts.readmePath ?? fromRepo("README.md");
  if (!exists(p)) {
    log("README.md missing; generation section not written");
    return false;
  }
  const text = await fsp.readFile(p, "utf8");
  const a = text.indexOf(README_START);
  const b = text.indexOf(README_END);
  if (a < 0 || b < a) {
    log("README.md has no generation markers; section not written");
    return false;
  }
  const next = text.slice(0, a) + renderGenerationSection(reports, opts.currentId) + text.slice(b + README_END.length);
  if (next === text) return false;
  await writeFileAtomic(p, next);
  return true;
}
