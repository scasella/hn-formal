import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DataJson, HnItem } from "./types.js";
import { HNFORMAL_BIN } from "./candidate.js";
import { validateData } from "./fetch.js";
import { HnClient, fetchOptionsFromEnv } from "./hn.js";
import { fromRepo, repoRoot } from "./paths.js";
import { ensureDir, envStr, exists, log, nowSec, readJson, runShell, tail, writeJsonAtomic } from "./util.js";

/**
 * Baseline check (DESIGN "Baseline check against real HN"): compare what HN
 * itself shows for the front page and 30 threads (a manually fetched HTML
 * fixture, see baseline.yml) with what the proven renderer shows for the
 * same items fetched from the API now.
 *
 * The fixture and the API data are minutes to hours apart, so only what is
 * stable is compared, and the verdict classes are explicit:
 *   FAIL  title or author text differs; a comments link where HN has none
 *         (or the reverse); a comment present on both sides under a
 *         different parent (the tree shape; comments never move); a page
 *         that parses to nothing; a fixture id absent from the render.
 *   WARN  HN's site string differs from our domain: HN strips subdomains
 *         ("news.vt.edu" -> "vt.edu") except on multi-user hosts, where it
 *         appends a path ("github.com/u"); `Spec.domainOf` keeps the host.
 *         The API has no item for a fixture id. HN shows comments we lack
 *         (deleted since, or the per-story cap).
 *   INFO  comments we have that HN lacks (posted since, or hidden by HN);
 *         sibling order differs (HN ranks by votes, which drift between the
 *         fetch and now); fixture front-page order vs the live top list.
 * Scores, comment counts, ages and hrefs are not compared: they drift, or
 * differ in bytes while naming the same thing (HN prints raw URLs, we
 * percent-encode).
 */

export type Level = "fail" | "warn" | "info";
export interface Finding {
  level: Level;
  check: string;
  id?: number;
  message: string;
}

export interface HnStory {
  id: number;
  title: string;
  site: string | null;
  by: string | null;
  hasCommentsLink: boolean;
}

export interface HnComment {
  id: number;
  indent: number;
}

/* ---------- HN HTML (news.ycombinator.com), flat rows, regex is enough ---------- */

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

/** Text content of an HTML snippet: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** The front page's story rows in order (`tr.athing.submission` + its subtext row). */
export function parseHnFront(html: string): HnStory[] {
  const out: HnStory[] = [];
  const row = /<tr class="athing submission" id="(\d+)">([\s\S]*?)(?=<tr class="athing submission" id="\d+">|<tr class="morespace"|<\/table>)/g;
  for (const m of html.matchAll(row)) {
    const id = Number(m[1]);
    const body = m[2]!;
    const t = body.match(/<span class="titleline"><a href="[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!t) continue;
    const site = body.match(/<span class="sitestr">([\s\S]*?)<\/span>/);
    const by = body.match(/<a href="user\?id=[^"]*" class="hnuser">([\s\S]*?)<\/a>/);
    const subtext = body.slice(body.indexOf('class="subtext"'));
    const hasCommentsLink = /<a href="item\?id=\d+">(?:\d+&nbsp;comments?|discuss)<\/a>/.test(subtext);
    out.push({ id, title: textOf(t[1]!), site: site ? textOf(site[1]!) : null, by: by ? textOf(by[1]!) : null, hasCommentsLink });
  }
  return out;
}

/** A thread page: the story row and the comment rows in order with HN's indent level. */
export function parseHnItem(html: string): { story: HnStory | null; comments: HnComment[] } {
  const front = parseHnFront(html);
  const story = front[0] ?? null;
  const comments: HnComment[] = [];
  const row = /<tr class="athing comtr" id="(\d+)">[\s\S]*?<td class="ind" indent="(\d+)">/g;
  for (const m of html.matchAll(row)) comments.push({ id: Number(m[1]), indent: Number(m[2]) });
  return { story, comments };
}

/* ---------- Our HTML (the proven serializer: fixed tag set, balanced) ---------- */

const VOID = new Set(["meta", "link", "br", "hr"]);

interface OurStory {
  id: number;
  title: string | null;
  domain: string | null;
  by: string | null;
  hasCommentsLink: boolean;
}

/** Story markers in document order with their own data-hn fields (text content). */
export function parseOurFront(html: string): OurStory[] {
  const out: OurStory[] = [];
  const marker = /<([a-z0-9]+)\b[^>]*\bdata-hn-story="(\d+)"[^>]*>/g;
  const starts = [...html.matchAll(marker)];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const from = s.index! + s[0].length;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : html.length;
    const chunk = html.slice(from, to);
    const field = (name: string) => {
      const m = chunk.match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\bdata-hn="${name}"[^>]*>([\\s\\S]*?)<\\/\\1>`));
      return m ? textOf(m[2]!) : null;
    };
    out.push({
      id: Number(s[2]),
      title: field("title"),
      domain: field("domain"),
      by: field("by"),
      hasCommentsLink: new RegExp(`<a\\b[^>]*\\bdata-hn="comments"`).test(chunk),
    });
  }
  return out;
}

/** Comment markers in document order with nesting depth (0 = top level). */
export function parseOurComments(html: string): HnComment[] {
  const out: HnComment[] = [];
  const stack: boolean[] = []; // true when the open element is a comment marker
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  for (const m of html.matchAll(tag)) {
    const name = m[1]!.toLowerCase();
    const closing = m[0].startsWith("</");
    if (closing) {
      stack.pop(); // the serializer balances tags
      continue;
    }
    if (VOID.has(name) || m[2]!.trimEnd().endsWith("/")) continue;
    const idm = m[2]!.match(/\bdata-hn-comment="(\d+)"/);
    if (idm) out.push({ id: Number(idm[1]), indent: stack.filter(Boolean).length });
    stack.push(!!idm);
  }
  return out;
}

/* ---------- Comparison ---------- */

export interface Report {
  fixtures: string;
  comparedAt: number;
  specVersion?: number;
  stories: number;
  threads: number;
  findings: Finding[];
  counts: Record<Level, number>;
  ok: boolean;
}

export function compareFront(hn: HnStory[], ours: OurStory[]): Finding[] {
  const f: Finding[] = [];
  if (hn.length === 0) f.push({ level: "fail", check: "parse", message: "fixture front page parsed to zero story rows" });
  if (ours.length === 0) f.push({ level: "fail", check: "parse", message: "our front page parsed to zero story markers" });
  const byId = new Map(ours.map((s) => [s.id, s]));
  for (const h of hn) {
    const o = byId.get(h.id);
    if (!o) {
      f.push({ level: "fail", check: "present", id: h.id, message: `fixture story ${h.id} is not on our front page` });
      continue;
    }
    if (o.title !== h.title) f.push({ level: "fail", check: "title", id: h.id, message: `title: HN "${h.title}" vs ours "${o.title}"` });
    if (h.by !== null) {
      if (o.by !== h.by) f.push({ level: "fail", check: "by", id: h.id, message: `author: HN "${h.by}" vs ours "${o.by}"` });
    } else if (o.by !== null) f.push({ level: "warn", check: "by", id: h.id, message: `HN shows no author (job row) but ours shows "${o.by}"` });
    if (h.hasCommentsLink !== o.hasCommentsLink) {
      f.push({ level: "fail", check: "comments-link", id: h.id, message: `comments link: HN ${h.hasCommentsLink} vs ours ${o.hasCommentsLink}` });
    }
    if (h.site !== null || o.domain !== null) {
      if (h.site === o.domain) continue;
      if (h.site && o.domain && h.site.startsWith(o.domain + "/")) {
        f.push({ level: "warn", check: "domain-path", id: h.id, message: `HN site "${h.site}" extends our domain "${o.domain}" (multi-user host)` });
      } else if (h.site && o.domain && o.domain.endsWith("." + h.site)) {
        f.push({ level: "warn", check: "domain-subdomain", id: h.id, message: `HN site "${h.site}" strips the subdomain of our domain "${o.domain}"` });
      } else f.push({ level: "fail", check: "domain", id: h.id, message: `domain: HN "${h.site}" vs ours "${o.domain}"` });
    }
  }
  return f;
}

/** Parent of each comment from a flat (id, indent) list: the nearest preceding row one level up; null at the top. */
export function parentsOf(rows: HnComment[]): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  const stack: HnComment[] = [];
  for (const c of rows) {
    while (stack.length && stack[stack.length - 1]!.indent >= c.indent) stack.pop();
    parents.set(c.id, stack.length ? stack[stack.length - 1]!.id : null);
    stack.push(c);
  }
  return parents;
}

export function compareThread(id: number, hn: HnComment[], ours: HnComment[]): Finding[] {
  const f: Finding[] = [];
  const ourIds = new Set(ours.map((c) => c.id));
  const hnIds = new Set(hn.map((c) => c.id));
  const missingIds = hn.filter((c) => !ourIds.has(c.id)).map((c) => c.id);
  const missing = missingIds.length;
  const extra = ours.filter((c) => !hnIds.has(c.id)).length;
  if (missing) {
    const sample = missingIds.slice(0, 3).join(", ") + (missing > 3 ? ", ..." : "");
    f.push({ level: "warn", check: "comments-missing", id, message: `${missing} comment(s) HN shows that we lack (deleted since, or the per-story cap): ${sample}` });
  }
  if (extra) f.push({ level: "info", check: "comments-extra", id, message: `${extra} comment(s) we have that HN lacks (posted since, or hidden by HN)` });
  // Tree shape on the common ids: same parent (or the parent is a comment one side lacks, already counted).
  const ph = parentsOf(hn);
  const po = parentsOf(ours);
  let parentMismatches = 0;
  for (const c of hn) {
    if (!ourIds.has(c.id)) continue;
    const a = ph.get(c.id) ?? null;
    const b = po.get(c.id) ?? null;
    if (a === b) continue;
    if ((a !== null && !ourIds.has(a)) || (b !== null && !hnIds.has(b))) continue;
    parentMismatches++;
    if (parentMismatches <= 3) f.push({ level: "fail", check: "comment-parent", id, message: `comment ${c.id}: HN parent ${a ?? "root"} vs ours ${b ?? "root"}` });
  }
  if (parentMismatches > 3) f.push({ level: "fail", check: "comment-parent", id, message: `${parentMismatches - 3} more comments under a different parent` });
  // Sibling order among the common ids: HN ranks by votes, so this drifts.
  const order = (rows: HnComment[], common: Set<number>, parents: Map<number, number | null>) => {
    const by = new Map<string, number[]>();
    for (const c of rows) {
      if (!common.has(c.id)) continue;
      const k = String(parents.get(c.id) ?? "root");
      by.set(k, [...(by.get(k) ?? []), c.id]);
    }
    return by;
  };
  const common = new Set(hn.filter((c) => ourIds.has(c.id)).map((c) => c.id));
  const oh = order(hn, common, ph);
  const oo = order(ours, common, po);
  let reordered = 0;
  for (const [k, ids] of oh) {
    const mine = oo.get(k) ?? [];
    if (ids.join(",") !== mine.join(",")) reordered++;
  }
  if (reordered) f.push({ level: "info", check: "comment-order", id, message: `${reordered} sibling group(s) in a different order (vote ranking drifted since the fetch)` });
  return f;
}

/* ---------- Driver ---------- */

export interface BaselineArgs {
  fixtures: string;
  data?: string;
  site?: string;
  out?: string;
}

async function fetchFixtureData(ids: number[]): Promise<{ data: DataJson; nulls: number[] }> {
  const opts = fetchOptionsFromEnv();
  await ensureDir(opts.cacheDir);
  const client = new HnClient(opts);
  const items = new Map<number, HnItem>();
  const nulls: number[] = [];
  const top: number[] = [];
  for (const id of ids) {
    if ((await client.item(id, true)) === null) nulls.push(id);
    else top.push(id);
  }
  await Promise.all(top.map((id) => client.tree(id, items)));
  const data: DataJson = { fetchedAt: nowSec(), top, items: {} };
  for (const id of [...items.keys()].sort((x, y) => x - y)) data.items[String(id)] = items.get(id)!;
  return { data, nulls };
}

export async function cmdBaseline(args: BaselineArgs): Promise<Report> {
  const abs = (p: string) => (path.isAbsolute(p) ? p : fromRepo(p));
  const fixtures = abs(args.fixtures);
  const idsPath = path.join(fixtures, "ids.txt");
  if (!exists(idsPath)) throw new Error(`baseline: ${idsPath} not found`);
  const ids = (await fsp.readFile(idsPath, "utf8")).split(/\s+/).filter(Boolean).map(Number);
  const findings: Finding[] = [];

  // Data: the fixture's ids from the API now (or a given file).
  let data: DataJson;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hn-baseline-"));
  let dataPath: string;
  if (args.data) {
    dataPath = abs(args.data);
    data = await readJson<DataJson>(dataPath);
  } else {
    const r = await fetchFixtureData(ids);
    data = r.data;
    for (const id of r.nulls) findings.push({ level: "warn", check: "api-null", id, message: `API has no item ${id}; dropped from the render` });
    dataPath = path.join(tmp, "data.json");
    await writeJsonAtomic(dataPath, data);
    log(`baseline: fetched ${data.top.length} stories, ${Object.keys(data.items).length} items from the API`);
  }
  if (data.top.length === 30) validateData(data);
  else findings.push({ level: "warn", check: "data", message: `data has ${data.top.length} top ids, not 30; the Lean binary may refuse it` });

  // Live order vs fixture order: drift, reported for the record only.
  try {
    const live = await new HnClient(fetchOptionsFromEnv()).topStories();
    const liveTop = new Set(live.slice(0, 30));
    const overlap = ids.filter((id) => liveTop.has(id)).length;
    findings.push({ level: "info", check: "live-order", message: `${overlap}/${ids.length} fixture stories are in the live top 30 now (order is not compared; it drifts)` });
  } catch (e) {
    findings.push({ level: "info", check: "live-order", message: `could not fetch live topstories: ${String((e as Error).message ?? e)}` });
  }

  // Render with the proven binary (or use a given site dir).
  let site: string;
  if (args.site) site = abs(args.site);
  else {
    site = path.join(tmp, "site");
    await ensureDir(site);
    const cmd = envStr("RENDER_CMD", `${HNFORMAL_BIN} render {data} {out}`).replace("{data}", dataPath).replace("{out}", site);
    const r = await runShell(cmd, { cwd: repoRoot(), timeoutMs: 10 * 60_000, env: { HNFORMAL_BIN } });
    if (r.code !== 0 || !exists(path.join(site, "index.html"))) {
      throw new Error(`baseline: render failed (exit ${r.code})\n${tail(r.stdout + r.stderr, 3000)}`);
    }
  }

  // Front page.
  const hnFront = parseHnFront(await fsp.readFile(path.join(fixtures, "index.html"), "utf8"));
  const ourFront = parseOurFront(await fsp.readFile(path.join(site, "index.html"), "utf8"));
  findings.push(...compareFront(hnFront, ourFront));

  // Threads.
  let threads = 0;
  for (const id of ids) {
    const hnPath = path.join(fixtures, "item", `${id}.html`);
    const ourPath = path.join(site, "item", `${id}.html`);
    if (!exists(hnPath)) {
      findings.push({ level: "warn", check: "fixture-item", id, message: `fixture has no item/${id}.html` });
      continue;
    }
    if (!exists(ourPath)) {
      if (data.top.includes(id)) findings.push({ level: "fail", check: "present", id, message: `we rendered no item/${id}.html` });
      continue;
    }
    threads++;
    const hn = parseHnItem(await fsp.readFile(hnPath, "utf8"));
    const ours = parseOurComments(await fsp.readFile(ourPath, "utf8"));
    if (hn.comments.length === 0 && /class="athing comtr"/.test(await fsp.readFile(hnPath, "utf8"))) {
      findings.push({ level: "fail", check: "parse", id, message: `fixture item/${id}.html has comment rows but none parsed` });
    }
    findings.push(...compareThread(id, hn.comments, ours));
  }

  const counts: Record<Level, number> = { fail: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  const specVersion = await (await import("./release.js")).specVersion();
  const report: Report = { fixtures: path.relative(repoRoot(), fixtures), comparedAt: nowSec(), specVersion, stories: hnFront.length, threads, findings, counts, ok: counts.fail === 0 };
  const out = args.out ? abs(args.out) : path.join(fixtures, "report.json");
  await writeJsonAtomic(out, report);
  for (const f of findings.filter((x) => x.level !== "info")) log(`${f.level.toUpperCase()} ${f.check}${f.id ? ` ${f.id}` : ""}: ${f.message}`);
  log(`baseline: ${report.ok ? "ok" : "FAIL"} stories=${report.stories} threads=${threads} fail=${counts.fail} warn=${counts.warn} info=${counts.info} -> ${out}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  return report;
}
