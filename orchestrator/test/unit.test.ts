import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, PRICING } from "../src/anthropic.js";
import { buildRunRecord, pickWinner } from "../src/aggregate.js";
import { cssLint } from "../src/candidate.js";
import { validateData } from "../src/fetch.js";
import { BRIEFS, briefFor, briefBlock, roundMessages } from "../src/prompts.js";
import type { CandidateRecord, DataJson } from "../src/types.js";
import { tail } from "../src/util.js";

test("costOf: low tier with 1h cache write", () => {
  const c = costOf({
    input_tokens: 1200,
    output_tokens: 6000,
    cache_creation_input_tokens: 40000,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40000 },
  });
  assert.equal(c.tier, "low");
  assert.equal(c.promptTokens, 41200);
  // 1200*0.1 + 40000*2*0.1 + 6000*0.5 per MTok
  assert.ok(Math.abs(c.usd - (0.00012 + 0.008 + 0.003)) < 1e-9);
});

test("costOf: cache read and the >100K rate card", () => {
  const c = costOf({ input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 98000 });
  assert.equal(c.tier, "high");
  assert.ok(Math.abs(c.usd - (0.0025 + 98000 * 0.1 * 0.5e-6 + 0.0025)) < 1e-9);
  assert.equal(PRICING.tierSplitTokens, 100_000);
});

test("cssLint mirrors the CONTRACT rules", () => {
  assert.deepEqual(cssLint('a::before { content: ""; } b { content: none }'), []);
  assert.deepEqual(cssLint("@font-face { src: url(/hn-formal/fonts/x.woff2) }"), []);
  assert.equal(cssLint('a::before { content: "hi" }').length, 1);
  assert.equal(cssLint("a { background: url(https://x.com/i.png) }").length, 1);
  assert.equal(cssLint("a { background: url('/img/i.png') }").length, 1);
  assert.equal(cssLint('@import url("/x.css");').length, 2); // @import + url outside /fonts/
  assert.deepEqual(cssLint('/* content: "in a comment" */ a { color: red }'), []);
});

test("briefs: unique keys, a verified move each, slot rotation by day", () => {
  const keys = new Set(BRIEFS.map((b) => b.key));
  assert.equal(keys.size, BRIEFS.length);
  for (const b of BRIEFS) assert.ok(b.title && b.text.length > 80 && b.move && typeof b.check === "function");
  assert.equal(briefFor(0, "20261009-000000").key, briefFor(BRIEFS.length, "20261009-000000").key);
  assert.notEqual(briefFor(0, "20261009-000000").key, briefFor(0, "20261010-000000").key);
  assert.equal(briefFor(0).key, BRIEFS[0]!.key);
});

test("roundMessages: first round has no previous files; repair rounds carry them", () => {
  const first = roundMessages({ round: 1, maxRounds: 10 });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.role, "user");
  const repair = roundMessages({
    round: 2,
    maxRounds: 10,
    previous: { renderLean: "LEAN", styleCss: "CSS", designNotes: "NOTES" },
    failure: { stage: "lake-build", output: "x".repeat(20_000) },
  });
  const text = String(repair[0]!.content);
  assert.ok(text.includes("LEAN") && text.includes("CSS") && text.includes("NOTES"));
  assert.ok(text.includes("lake-build"));
  assert.ok(text.includes("truncated"));
  assert.ok(text.length < 20_000);
});

test("tail keeps the end", () => {
  const t = tail("abcdef", 3);
  assert.ok(t.endsWith("def"));
});

function cand(n: number, over: Partial<CandidateRecord>): CandidateRecord {
  return {
    runId: "R",
    n,
    brief: "b",
    model: "m",
    startedAt: 100 + n,
    finishedAt: 200,
    rounds: 1,
    tier1: "ok",
    tier2: "ok",
    judge: 50,
    lastError: "",
    costUsd: 0.1,
    calls: 2,
    stopReason: "passed",
    roundLog: [],
    renderLean: "x",
    styleCss: "y",
    ...over,
  };
}

test("pickWinner prefers highest judge among passers, null judge last, ties by n", () => {
  const cands = [
    cand(0, { judge: 70, tier2: "fail:axe", stopReason: "failed" }),
    cand(1, { judge: null }),
    cand(2, { judge: 60 }),
    cand(3, { judge: 60 }),
  ];
  assert.equal(pickWinner(cands)!.n, 2);
  assert.equal(pickWinner([cand(1, { judge: null })])!.n, 1);
  assert.equal(pickWinner([cand(0, { stopReason: "cap-hit" })]), null);
});

test("buildRunRecord stop reasons", () => {
  assert.equal(buildRunRecord("R", [cand(0, {})], "rel").stopReason, "released");
  assert.equal(buildRunRecord("R", [cand(0, { stopReason: "cap-hit", tier2: "n/a" })], null).stopReason, "cap-hit");
  assert.equal(buildRunRecord("R", [cand(0, { stopReason: "killed" })], null).stopReason, "killed");
  assert.equal(buildRunRecord("R", [cand(0, { stopReason: "failed", tier2: "fail:vnu" })], null).stopReason, "no-passer");
  const r = buildRunRecord("R", [cand(0, {}), cand(1, { tier1: "fail:lake-build", tier2: "n/a", stopReason: "failed" })], null);
  assert.equal(r.passedTier1, 1);
  assert.equal(r.passedTier2, 1);
  assert.equal(r.calls, 4);
  assert.equal(r.startedAt, 100);
});

test("validateData enforces the CONTRACT shape", () => {
  const items: DataJson["items"] = {};
  const top: number[] = [];
  for (let i = 1; i <= 30; i++) {
    top.push(i);
    items[String(i)] = { id: i, type: "story" };
  }
  validateData({ fetchedAt: 1, top, items });
  assert.throws(() => validateData({ fetchedAt: 1, top: top.slice(0, 29), items }));
  assert.throws(() => validateData({ fetchedAt: 1, top, items: { ...items, "31": { id: 32, type: "story" } } }));
});

test("SITE_PREFIX normalization and request mapping", async () => {
  const { normalizePrefix, stripPrefix, serveStatic } = await import("../src/server.js");
  assert.equal(normalizePrefix(undefined), "/hn-formal");
  assert.equal(normalizePrefix(""), "");
  assert.equal(normalizePrefix("/"), "");
  assert.equal(normalizePrefix("hn-formal"), "/hn-formal");
  assert.equal(normalizePrefix("/hn-formal/"), "/hn-formal");
  assert.equal(normalizePrefix("//x//"), "/x");
  assert.equal(stripPrefix("/hn-formal/style.css", "/hn-formal"), "/style.css");
  assert.equal(stripPrefix("/hn-formal/", "/hn-formal"), "/");
  assert.equal(stripPrefix("/hn-formal", "/hn-formal"), "/");
  assert.equal(stripPrefix("/hn-formalx/a", "/hn-formal"), null);
  assert.equal(stripPrefix("/style.css", "/hn-formal"), null); // outside the prefix: 404 like Pages
  assert.equal(stripPrefix("/hn-formal/style.css", ""), "/hn-formal/style.css");

  const site = new URL("./fixture-site", import.meta.url).pathname;
  const server = await serveStatic(site, "/hn-formal");
  try {
    assert.equal(server.pageUrl("index.html"), `${server.url}/hn-formal/index.html`);
    const get = async (p: string) => (await fetch(server.url + p)).status;
    assert.equal(await get("/hn-formal/index.html"), 200);
    assert.equal(await get("/hn-formal/style.css"), 200);
    assert.equal(await get("/hn-formal/item/1.html"), 200);
    assert.equal(await get("/hn-formal/"), 200);
    assert.equal(await get("/hn-formal"), 200);
    assert.equal(await get("/style.css"), 404); // unprefixed 404s, as on Pages
    assert.equal(await get("/hn-formal/nope.html"), 404);
    assert.equal(await get("/hn-formal/../../etc/passwd"), 404);
  } finally {
    await server.close();
  }
  const bare = await serveStatic(site, "");
  try {
    assert.equal(bare.pageUrl("index.html"), `${bare.url}/index.html`);
    assert.equal((await fetch(bare.url + "/style.css")).status, 200);
  } finally {
    await bare.close();
  }
});

test("structure check: class attributes are ignored, anything else counts", async () => {
  const { normalizeDom, sameDom, domChangedVs } = await import("../src/candidate.js");
  assert.equal(normalizeDom('<div class="a b"><p class="x">t</p></div>'), "<div><p>t</p></div>");
  assert.ok(sameDom('<li class="row">x</li>', "<li>x</li>"));
  assert.ok(!sameDom("<li><b>x</b></li>", "<li>x</li>"));
  // Only <main> counts: a wrapper around the nav is not a structural change.
  assert.ok(sameDom('<body><header><div><nav>n</nav></div></header><main class="m"><ol><li>a</li></ol></main><footer><section>f</section></footer></body>',
    "<body><header><nav>n</nav></header><main><ol><li>a</li></ol></main><footer>f</footer></body>"));
  assert.ok(!sameDom("<body><main><ol><li>a</li></ol></main></body>", "<body><main><table><tr><td>a</td></tr></table></main></body>"));
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "hn-base-"));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "hn-out-"));
  await fs.mkdir(path.join(base, "item"));
  await fs.mkdir(path.join(out, "item"));
  await fs.writeFile(path.join(base, "index.html"), '<main><ol class="s"><li>a</li></ol></main>');
  await fs.writeFile(path.join(out, "index.html"), '<main><ol class="stories"><li>a</li></ol></main>');
  await fs.writeFile(path.join(base, "item", "1.html"), "<main><article>c</article></main>");
  await fs.writeFile(path.join(out, "item", "1.html"), "<main><article>c</article></main>");
  assert.equal(await domChangedVs(base, out), false);
  await fs.writeFile(path.join(out, "item", "1.html"), "<main><article><h1>c</h1></article></main>");
  assert.equal(await domChangedVs(base, out), true);
  await fs.rm(path.join(base, "item", "1.html"));
  assert.equal(await domChangedVs(base, out), true);
});

test("pickWinner: equal judge scores go to the changed DOM", () => {
  const cands = [cand(0, { judge: 60, domChanged: false }), cand(1, { judge: 60, domChanged: true }), cand(2, { judge: 60 })];
  assert.equal(pickWinner(cands)!.n, 1);
  assert.equal(pickWinner([cand(0, { judge: 61, domChanged: false }), cand(1, { judge: 60, domChanged: true })])!.n, 0);
  const r = buildRunRecord("R", cands, null);
  assert.deepEqual(r.perCandidate.map((c) => c.domChanged), [false, true, null]);
});

test("roundMessages: a structure failure asks for a new tree, not a fix", () => {
  const m = roundMessages({
    round: 2,
    maxRounds: 10,
    previous: { renderLean: "L", styleCss: "C", designNotes: "N" },
    failure: { stage: "structure", output: "structure check: ..." },
  });
  const text = String(m[0]!.content);
  assert.ok(text.includes("change the document structure"));
  assert.ok(!text.includes("keep the design,"));
});

test("specVersion comes from Spec.lean", async () => {
  const { specVersion } = await import("../src/release.js");
  assert.ok((await specVersion()) >= 2);
});

test("README generation section: current screenshot, previous thumbnails, no judge notes", async () => {
  const { renderGenerationSection, updateReadme, README_START, README_END } = await import("../src/readme.js");
  const rel = (id: string, score: number | null, extra: Record<string, unknown> = {}) =>
    ({ id, runId: "R", specVersion: 2, tier1: { lakeBuild: "ok", axioms: [], selftest: "ok" }, tier2: { vnu: 0, axe: 0, contrastMin: 5, reflowWidth: 375, csp: "ok" },
      judge: { score, notes: "SECRET-NOTES" }, model: "m", repairRounds: 1, costUsd: 0.0312, previousRelease: null, diffStat: "+1 -1", ...extra }) as any;
  const reports = [rel("20261009-134625-aaaaaaa", 72, { brief: "cards <b>", domChanged: true }), rel("20261009-105817-bbbbbbb", 74), rel("20261009-003724-ccccccc", null)];
  const sec = renderGenerationSection(reports);
  assert.ok(sec.startsWith(README_START) && sec.endsWith(README_END));
  assert.ok(sec.includes("releases/20261009-134625-aaaaaaa/index-1280.png"));
  assert.ok(sec.includes('brief "cards b"') && sec.includes("judge 72/100") && sec.includes("new DOM") && sec.includes("1 repair round ·"));
  assert.ok(sec.includes("releases/20261009-105817-bbbbbbb/index-375.png") && sec.includes("releases/20261009-003724-ccccccc/index-375.png"));
  assert.ok(!sec.includes("SECRET-NOTES"));
  // rollback target becomes current
  assert.ok(renderGenerationSection(reports, "20261009-105817-bbbbbbb").includes("releases/20261009-105817-bbbbbbb/index-1280.png"));
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hn-readme-"));
  const p = path.join(dir, "README.md");
  await fs.writeFile(p, `# x\n\n${README_START}\n${README_END}\n\nrest\n`);
  assert.equal(await updateReadme(reports, { readmePath: p }), true);
  assert.equal(await updateReadme(reports, { readmePath: p }), false);
  const text = await fs.readFile(p, "utf8");
  assert.ok(text.startsWith("# x\n\n") && text.endsWith("\n\nrest\n") && text.includes("## Current generation"));
  await fs.writeFile(p, "# no markers\n");
  assert.equal(await updateReadme(reports, { readmePath: p }), false);
});

// The plain list shape of the worked example: no brief's required move is present in it.
function plainMain(stories = 30): string {
  let li = "";
  for (let i = 0; i < stories; i++) li += `<li data-hn-story="${i}"><div class="titleline"><a href="/x" data-hn="title">t</a></div><div class="subline"><span data-hn="score">1</span> points</div></li>`;
  return `<main><ol class="stories">${li}</ol><p><a href="/more">More</a></p></main>`;
}
function plainItem(comments = 3): string {
  let c = "";
  for (let i = 0; i < comments; i++) c += `<li data-hn-comment="${i}"><div data-hn="text"><p>c</p></div></li>`;
  return `<main><article data-hn-story="9"><div><a data-hn="title">t</a></div></article><ol>${c}</ol></main>`;
}

test("brief checks: every brief rejects the plain list shape and accepts its own move", () => {
  for (const b of BRIEFS) assert.ok(b.check(plainMain(), plainItem()), `${b.key} should reject the plain shape`);
  const rows = Array.from({ length: 30 }, (_, i) => `<tr data-hn-story="${i}"><td><a data-hn="title">t</a></td><td>1</td></tr>`).join("");
  const table = `<main><table><thead><tr><th>rank</th><th>title</th><th>points</th></tr></thead><tbody>${rows}</tbody></table></main>`;
  assert.equal(BRIEFS.find((b) => b.key === "spreadsheet")!.check(table, plainItem()), null);
  assert.equal(BRIEFS.find((b) => b.key === "classic")!.check(table, plainItem()), null);
  const cards = `<main><div>${Array.from({ length: 30 }, (_, i) => `<article data-hn-story="${i}"><h3><a data-hn="title">t</a></h3><small>d</small></article>`).join("")}</div></main>`;
  assert.equal(BRIEFS.find((b) => b.key === "cards")!.check(cards, plainItem()), null);
  assert.equal(BRIEFS.find((b) => b.key === "reader")!.check(cards, plainItem()), null);
  assert.equal(BRIEFS.find((b) => b.key === "paper")!.check(cards, plainItem()), null);
  assert.equal(BRIEFS.find((b) => b.key === "pastel")!.check(cards, plainItem()), null);
  const mag = `<main><section><article data-hn-story="0">a</article></section><section>b</section><section>c</section></main>`;
  const quotes = `<main><ol>${Array.from({ length: 3 }, (_, i) => `<blockquote data-hn-comment="${i}"><div data-hn="text"><p>c</p></div></blockquote>`).join("")}</ol></main>`;
  assert.equal(BRIEFS.find((b) => b.key === "magazine")!.check(mag, quotes), null);
  assert.ok(BRIEFS.find((b) => b.key === "magazine")!.check(mag, plainItem()));
  const timeline = `<main><ol>${Array.from({ length: 30 }, (_, i) => `<li data-hn-story="${i}"><time>1h</time><a data-hn="title">t</a></li>`).join("")}</ol></main>`;
  assert.equal(BRIEFS.find((b) => b.key === "timeline")!.check(timeline, plainItem()), null);
  // Fewer stories than usual still works (the API can return fewer than 30).
  assert.equal(BRIEFS.find((b) => b.key === "timeline")!.check(timeline.replace(/<li data-hn-story="2[0-9]".*?<\/li>/g, ""), plainItem()), null);
});

test("brief block carries the move and the do-not-repeat list; round 1 can carry the live screenshot", () => {
  const b = briefFor(3, "20261009-000000");
  const text = briefBlock(b, ["broadsheet", "cards on a grid"]).text;
  assert.ok(text.includes(b.title) && text.includes(b.move) && text.includes('"broadsheet"') && text.includes("Do not repeat"));
  const m = roundMessages({ round: 1, maxRounds: 10, currentSitePng: "AAAA" });
  const content = m[0]!.content as Array<{ type: string }>;
  assert.ok(Array.isArray(content) && content.some((c) => c.type === "image") && content.some((c) => c.type === "text"));
  assert.equal(typeof roundMessages({ round: 1, maxRounds: 10 })[0]!.content, "string");
});

test("judge composite and novelty tie-break", async () => {
  const { compositeScore } = await import("../src/judge.js");
  assert.equal(compositeScore({ adherence: 80, novelty: 65, craft: 66 }), 71);
  assert.equal(compositeScore({ adherence: 200, novelty: -5, craft: 50 }), 55);
  const a = cand(0, { judge: 70, judgeDetail: { adherence: 70, novelty: 40, craft: 90 } });
  const b = cand(1, { judge: 70, judgeDetail: { adherence: 60, novelty: 80, craft: 70 } });
  assert.equal(pickWinner([a, b])!.n, 1);
  assert.equal(buildRunRecord("R", [a, b], null).perCandidate[1]!.novelty, 80);
});

test("prompt estimate counts an image as a flat budget, not its base64 length", async () => {
  const { estimateMessageTokens, IMAGE_TOKEN_ESTIMATE } = await import("../src/anthropic.js");
  const big = "A".repeat(600_000);
  const withImage = estimateMessageTokens([
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: big } }, { type: "text", text: "go" }] },
  ]);
  assert.ok(withImage < IMAGE_TOKEN_ESTIMATE + 100, `got ${withImage}`);
  assert.equal(estimateMessageTokens([{ role: "user", content: "x".repeat(300) }]), 100);
});

test("effort steps down one level after a max_tokens hit and stops at low", async () => {
  const { stepDownEffort } = await import("../src/anthropic.js");
  assert.equal(stepDownEffort("xhigh"), "high");
  assert.equal(stepDownEffort("high"), "medium");
  assert.equal(stepDownEffort("low"), "low");
});

test("site-extras: feed and sitemap are deterministic, escaped, and the preview falls back", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { renderFeed, renderSitemap, releaseSummary, writeSiteExtras } = await import("../src/siteExtras.js");
  const mk = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      runId: "r",
      specVersion: 3,
      tier1: {} as never,
      tier2: {} as never,
      judge: { score: 80, notes: "MODEL OUTPUT <b>", adherence: 85, novelty: 70, craft: 75 },
      model: "m",
      repairRounds: 1,
      costUsd: 0.1234,
      previousRelease: null,
      diffStat: "+1 -1",
      candidate: 0,
      brief: "cards & grids",
      domChanged: true,
      createdAt: 1760092800,
      ...extra,
    }) as never;
  const reports = [mk("20261010-103156-c4ed73e"), mk("20261009-235900-437def3", { createdAt: 1760050800, brief: undefined })];
  const feed = renderFeed(reports, "https://example.test/hn/");
  assert.equal(feed, renderFeed(reports, "https://example.test/hn/"));
  assert.ok(feed.includes("<updated>2025-10-10T10:40:00Z</updated>"));
  assert.ok(feed.includes("Generation 20261010-103156-c4ed73e: cards &amp; grids"));
  assert.ok(feed.includes("<title>Generation 20261009-235900-437def3</title>"));
  assert.ok(!feed.includes("MODEL OUTPUT"), "judge notes never enter the feed");
  assert.ok(feed.includes("https://example.test/hn/loop/releases/20261010-103156-c4ed73e/index-1280.png"));
  assert.equal(releaseSummary(reports[0]!), 'Brief "cards & grids". Judge 80/100, novelty 70. Spec v3. New DOM. 1 repair round, $0.12.');
  const map = renderSitemap("https://example.test/hn/");
  assert.ok(map.includes("<loc>https://example.test/hn/</loc>") && map.includes("<loc>https://example.test/hn/loop/</loc>"));
  assert.ok(!map.includes("item/"), "item pages are not in the sitemap");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hn-extras-"));
  const rel = path.join(tmp, "releases", "20261010-103156-c4ed73e");
  await fs.mkdir(rel, { recursive: true });
  await fs.writeFile(path.join(rel, "index-1280.png"), "fallback");
  const out = path.join(tmp, "out");
  const written = await writeSiteExtras(out, reports, { siteUrl: "https://example.test/hn/", releasesDir: path.join(tmp, "releases") });
  assert.deepEqual(written.map((p) => path.basename(p)), ["feed.xml", "sitemap.xml", "preview.png"]);
  assert.equal(await fs.readFile(path.join(out, "preview.png"), "utf8"), "fallback");
  await fs.writeFile(path.join(rel, "preview.png"), "cropped");
  await writeSiteExtras(out, reports, { siteUrl: "https://example.test/hn/", releasesDir: path.join(tmp, "releases") });
  assert.equal(await fs.readFile(path.join(out, "preview.png"), "utf8"), "cropped");
  await fs.rm(tmp, { recursive: true, force: true });
});
