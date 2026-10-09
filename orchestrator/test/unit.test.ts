import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, PRICING } from "../src/anthropic.js";
import { buildRunRecord, pickWinner } from "../src/aggregate.js";
import { cssLint } from "../src/candidate.js";
import { validateData } from "../src/fetch.js";
import { BRIEFS, briefFor, roundMessages } from "../src/prompts.js";
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

test("briefs are divergent and selection wraps", () => {
  assert.ok(BRIEFS.length >= 20);
  assert.equal(new Set(BRIEFS).size, BRIEFS.length);
  assert.equal(briefFor(0), BRIEFS[0]);
  assert.equal(briefFor(BRIEFS.length + 3), BRIEFS[3]);
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
