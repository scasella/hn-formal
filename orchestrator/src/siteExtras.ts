import fsp from "node:fs/promises";
import path from "node:path";
import type { ReleaseReport } from "./types.js";
import { fromRepo } from "./paths.js";
import { SITE_URL } from "./readme.js";
import { ensureDir, exists, log, writeFileAtomic } from "./util.js";

/**
 * Discoverability files written next to the rendered site by build-site.sh
 * (CONTRACT "Site layout on Pages"):
 *   /feed.xml      Atom feed, one entry per release (newest first)
 *   /sitemap.xml   the front page and the dashboard only (item pages churn
 *                  every 15 minutes and are a mirror of HN comments)
 *   /preview.png   the current release's social-card screenshot, the fixed
 *                  URL Spec.previewHref points og:image at
 * Like the README section, the text here is orchestrator-generated (ids,
 * numbers, the brief from the fixed list); judge notes are model output and
 * stay out.
 */

export const REPO_URL = "https://github.com/scasella/hn-formal";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Release facts as one sentence, deterministic. */
export function releaseSummary(r: ReleaseReport): string {
  const parts = [
    r.brief ? `Brief "${r.brief}".` : null,
    r.judge.score !== null ? `Judge ${r.judge.score}/100${r.judge.novelty !== undefined ? `, novelty ${r.judge.novelty}` : ""}.` : null,
    `Spec v${r.specVersion}.`,
    r.domChanged === true ? "New DOM." : r.domChanged === false ? "CSS-only restyle." : null,
    `${r.repairRounds} repair round${r.repairRounds === 1 ? "" : "s"}, $${r.costUsd.toFixed(2)}.`,
  ].filter((x): x is string => x !== null);
  return parts.join(" ");
}

/** Atom feed of releases. `updated` is the newest release's time, so the
 * output is a pure function of the index (builds every 15 minutes must not
 * churn the file). */
export function renderFeed(reports: ReleaseReport[], siteUrl = SITE_URL): string {
  const newest = reports[0]?.createdAt ?? 0;
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom">`,
    `  <title>HN, formally: generations</title>`,
    `  <subtitle>The Hacker News front page, redesigned every night by an AI and proven in Lean 4 before it ships.</subtitle>`,
    `  <id>${esc(siteUrl)}feed.xml</id>`,
    `  <link href="${esc(siteUrl)}" />`,
    `  <link rel="self" href="${esc(siteUrl)}feed.xml" />`,
    `  <updated>${iso(newest)}</updated>`,
    `  <author><name>hn-formal</name><uri>${esc(REPO_URL)}</uri></author>`,
  ];
  for (const r of reports) {
    const shot = `${siteUrl}loop/releases/${encodeURIComponent(r.id)}/index-1280.png`;
    const files = `${REPO_URL}/tree/main/releases/${encodeURIComponent(r.id)}`;
    const title = r.brief ? `Generation ${r.id}: ${r.brief}` : `Generation ${r.id}`;
    lines.push(
      `  <entry>`,
      `    <title>${esc(title)}</title>`,
      `    <id>${esc(files)}</id>`,
      `    <link href="${esc(siteUrl)}" />`,
      `    <link rel="enclosure" type="image/png" href="${esc(shot)}" />`,
      `    <link rel="related" href="${esc(files)}" />`,
      `    <updated>${iso(r.createdAt ?? newest)}</updated>`,
      `    <summary>${esc(releaseSummary(r))}</summary>`,
      `  </entry>`,
    );
  }
  lines.push(`</feed>`, ``);
  return lines.join("\n");
}

export function renderSitemap(siteUrl = SITE_URL): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    `  <url><loc>${esc(siteUrl)}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${esc(siteUrl)}loop/</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    `</urlset>`,
    ``,
  ].join("\n");
}

/** The current release's social-card image: preview.png, else the 1280px
 * front page (releases before the preview shot existed). */
export function previewSource(reports: ReleaseReport[], currentId?: string, releasesDir = fromRepo("releases")): string | null {
  const cur = (currentId ? reports.find((r) => r.id === currentId) : undefined) ?? reports[0];
  if (!cur) return null;
  for (const name of ["preview.png", "index-1280.png"]) {
    const p = path.join(releasesDir, cur.id, name);
    if (exists(p)) return p;
  }
  return null;
}

export async function writeSiteExtras(outDir: string, reports: ReleaseReport[], opts: { siteUrl?: string; releasesDir?: string; currentId?: string } = {}): Promise<string[]> {
  await ensureDir(outDir);
  const siteUrl = opts.siteUrl ?? SITE_URL;
  const written: string[] = [];
  const feed = path.join(outDir, "feed.xml");
  await writeFileAtomic(feed, renderFeed(reports, siteUrl));
  written.push(feed);
  const sitemap = path.join(outDir, "sitemap.xml");
  await writeFileAtomic(sitemap, renderSitemap(siteUrl));
  written.push(sitemap);
  const src = previewSource(reports, opts.currentId, opts.releasesDir);
  if (src) {
    const dst = path.join(outDir, "preview.png");
    await fsp.copyFile(src, dst);
    written.push(dst);
  } else log("site-extras: no release screenshot found; /preview.png not written");
  return written;
}
