# Interface contract

Three parts, built in parallel. This file is the agreement between them.
Change it only with a commit that touches all affected parts.

## Repo layout

```
HnFormal/            Lean library: Item, Dom, Html (serializer), Sanitize,
                     Spec, Lemmas (+ hn_auto), Check (Bool mirror), Fixtures
HnFormal/Render.lean LLM-EDITABLE: the renderer + its proof
Main.lean            Lean executable entry (`hnformal`)
lakefile.toml, lean-toolchain
site/style.css       LLM-EDITABLE: the stylesheet
site/fonts/          fixed self-hosted font allowlist (may be empty)
dashboard/           fixed human-designed loop dashboard (static HTML+JS, reads JSON)
orchestrator/        TypeScript CLI (fetch, candidates, tier2, judge, release)
releases/            one dir per release, see below; releases/index.json
runs/                one JSON per redesign run (passed or failed); runs/index.json
fixtures/baseline/   manually fetched HN HTML + timestamp + report.json, the baseline check
.github/workflows/   refresh.yml (fetch, build, deploy Pages), redesign.yml, baseline.yml, ci.yml
scripts/             css-lint, axiom-check, misc shell
```

The only paths a candidate may change: `HnFormal/Render.lean`, `site/style.css`.
The release step also rewrites the generation section of `README.md`
(between `<!-- generation:start -->` and `<!-- generation:end -->`) from
`releases/index.json`: the current release's screenshot linking to the live
site, its id, brief, score, spec version and cost, and thumbnails of the
previous six. That text is orchestrator-generated; model output (judge
notes) never goes in. `npm run cli -- readme` regenerates it; `rollback`
updates it too.
CI (`ci.yml`) fails any PR or bot commit whose diff touches other paths unless
the commit is tagged `[human]` in its message or authored by a human.

## Data JSON (orchestrator -> Lean)

File produced by `orchestrator fetch`, consumed by `hnformal render`:

```json
{
  "fetchedAt": 1760000000,
  "top": [50008427, 50008111, ...],          // exactly 30 ids, API order
  "items": {
    "50008427": { "id": 50008427, "type": "story", "by": "pg", "time": 1759990000,
                  "title": "...", "url": "https://...", "score": 123,
                  "descendants": 45, "kids": [50008500, ...] },
    "50008500": { "id": 50008500, "type": "comment", "by": "x", "time": 1759991000,
                  "parent": 50008427, "text": "<p>html</p>", "kids": [] },
    ...
  }
}
```

- Field set mirrors the Firebase API exactly; every field except `id` and
  `type` is optional. `type` in {job, story, comment, poll, pollopt}.
- `items` contains the 30 top items and every reachable comment (via `kids`)
  up to the fetch cap. Missing kids (cap hit, or API returned null) are simply
  absent from `items`; the renderer treats an absent kid as not present.
- `deleted`/`dead` booleans may appear; the renderer must handle them.

## Lean executable

```
hnformal render <data.json> <outdir>
```
Writes `<outdir>/index.html` and `<outdir>/item/<id>.html` for each of the 30
top ids. Every page links the stylesheet as `Spec.styleHref`
(`/hn-formal/style.css`: root-relative including the Pages prefix
`Spec.sitePrefix`) and nothing else external. Exit 0 on success, 2 on malformed data JSON.

```
hnformal check <data.json>
```
Runs the Bool mirror of the spec (`HnFormal/Check.lean`) on the pages it
would render; prints `ok <page>` or `FAIL <page>: <predicate>` per page.
Exit 0/1. (Sanity only; the theorem in Render.lean is the real guarantee.)

```
hnformal selftest
```
Renders built-in fixtures (including jobs, polls, deleted/dead comments, deep
trees, hostile HTML) and runs `check` on them. Exit 0/1.

## Candidate protocol (orchestrator <-> Lean)

A candidate is `{ renderLean: string, styleCss: string }`. `Render.lean` must
begin with `set_option maxHeartbeats 2000000` and `set_option maxRecDepth
4096`. To evaluate:

1. Write both files into a clean checkout of main.
2. `scripts/css-lint.sh site/style.css`  (no non-empty `content:`, no `url(`
   outside `/hn-formal/fonts/`, no `@import`). Exit 1 = fail with reason on stdout.
3. `lake build` (exit != 0 => tier-1 fail; stderr is the repair signal).
4. `scripts/axiom-check.sh` runs `lake env lean scripts/Axioms.lean` which
   does `#print axioms HnFormal.Render.render_ok` and fails if the set is not a
   subset of {propext, Classical.choice, Quot.sound}. Fail = tier-1 fail.
5. `lake exe hnformal selftest` (must pass; defense in depth).
6. `lake exe hnformal render data/latest.json out/` then tier 2 on `out/`.
7. Structure check (soft; orchestrator). Before step 1 the orchestrator
   renders the files currently in place into `out-base/`. After tier 2
   passes it compares the `main` element of `index.html` and of the first
   item page in `out/` and `out-base/` with `class` attributes removed
   (header, nav and footer do not count). Identical means a CSS-only
   restyle: during the candidate's first `STRUCTURE_ROUNDS` rounds (default
   2; 0 disables) that is a failure at stage `structure`, fed back like any
   other, and the pass is kept as a fallback that ships if no later round
   passes. Beyond those rounds a CSS-only pass is accepted outright. The
   result is `domChanged` (true/false; absent when the check did not run) on
   the candidate record, the run record and the release report.
8. Brief check (soft; orchestrator). Every design brief
   (`orchestrator/src/prompts.ts`, `BRIEFS`) names one required structural
   move and a check on the rendered HTML: the `main` of `index.html` and of
   the item page with the most comments (for example "stories are `<tr>`
   rows of a `<table>`", "no `<ol>`/`<ul>` inside main"). A missing move is
   handled exactly like step 7 (stage `brief`, same rounds, same fallback)
   and recorded as `briefOk`. Briefs rotate across candidate slots by day
   (`briefFor(n, runId)`), so a slot does not get the same brief every run.

The prompt's worked example is fixed: `orchestrator/examples/Render.v0.lean`
and `style.v0.css`, the plain human-written renderer, not the last release.
CI proves the example still builds against the library. The brief block also
lists the last five releases' briefs as designs not to repeat, and round 1
includes a screenshot of the current live site as the thing not to resemble.

Tier 2 (orchestrator, Playwright + Chromium):
- vnu.jar on every html file: zero errors.
- axe-core on index.html and 3 item pages: zero violations of impact
  serious/critical.
- contrast: every text node's computed fg/bg >= 4.5:1 (3:1 for >= 24px).
- reflow: at 375px viewport, document.scrollWidth <= 375.
- CSP header simulated: no inline script, no <script>, no external origins
  in computed stylesheet (belt and braces over css-lint).

Judge (orchestrator): `claude-haiku-5-5` with the candidate's brief, a
screenshot of the current live site (the novelty reference), and the
candidate's screenshots (1280px and 375px of index.html, 1280px of one item
page; a fourth, index.html in a 1280x670 viewport, is the social-card crop
and is not shown to the judge). Returns `{ adherence, novelty, craft: 0-100, notes }`; the composite
`score` is `round(0.4 adherence + 0.3 novelty + 0.3 craft)`. Never blocks.
The winner among passers is the highest score; ties go to higher novelty,
then `domChanged: true`, then the lowest `n`.

## Release record

`releases/<YYYYMMDD-HHMMSS>-<shortsha>/`:
```
Render.lean  style.css  report.json  index-1280.png  index-375.png  item-1280.png  preview.png
```
(`preview.png`, the 1280x670 social-card crop, exists from 2026-10-10 on.)
`report.json`:
```json
{ "id": "20261009-031500-ab12cd3", "runId": "...", "specVersion": 3,
  "tier1": { "lakeBuild": "ok", "axioms": ["propext","Classical.choice","Quot.sound"], "selftest": "ok" },
  "tier2": { "vnu": 0, "axe": 0, "contrastMin": 4.7, "reflowWidth": 375, "csp": "ok" },
  "judge": { "score": 71, "adherence": 80, "novelty": 65, "craft": 66, "notes": "..." },
  "model": "claude-haiku-5-5", "repairRounds": 3, "costUsd": 0.42,
  "previousRelease": "...", "diffStat": "+120 -84", "candidate": 9,
  "brief": "cards on a grid", "briefOk": true, "domChanged": true }
```
`releases/index.json` is the array of all report.json, newest first.
A release = one commit to main by the bot that replaces the two editable
files and adds the release dir. Rollback = `orchestrator rollback <id>`
which re-copies that release's two files and commits.

## Run record

`runs/<runId>.json`:
```json
{ "runId": "20261009-030000", "startedAt": ..., "finishedAt": ...,
  "candidates": 16, "passedTier1": 5, "passedTier2": 3, "released": "<id>|null",
  "costUsd": 2.11, "calls": 97, "stopReason": "released|no-passer|cap-hit|killed",
  "perCandidate": [ { "n": 0, "rounds": 4, "tier1": "ok|fail:<stage>", "tier2": "ok|fail:<check>", "judge": 71, "novelty": 65, "briefOk": true, "domChanged": true, "lastError": "..." } ] }
```

## Guardrails (orchestrator)

- `KILL_SWITCH` file at repo root on main: if present, every workflow exits 0
  immediately with "paused".
- Spend: per-run cap `RUN_CAP_USD` (default 25) and monthly cap
  `MONTH_CAP_USD` (default 400); costs computed from `usage` on every
  response at Haiku 5.5 list prices; month total persisted in
  `runs/spend-<YYYY-MM>.json`. Exceeding either => stopReason cap-hit.
- Max calls per run `MAX_CALLS` (default 200).
- Auth: `ANTHROPIC_API_KEY` secret only. Never logged.

## Dashboard

Static files in `dashboard/`, copied to `<site>/loop/`. Reads
`releases.json` and `runs.json` relative to itself (copies of the two index files
made at deploy time) and renders: current release, gallery of all releases
with screenshots and scores, run history incl. failures, spec version,
trusted-base list (static text), link to repo.

## Site layout on Pages

Served under `Spec.sitePrefix` = `/hn-formal` (https://scasella.github.io/hn-formal/):

```
/hn-formal/index.html  /hn-formal/item/<id>.html  /hn-formal/style.css
/hn-formal/fonts/*  /hn-formal/loop/*  /hn-formal/spec/Spec.lean (copy)
/hn-formal/feed.xml  /hn-formal/sitemap.xml  /hn-formal/preview.png
```

The last three are discoverability files written by `cli site-extras` at
build time (`orchestrator/src/siteExtras.ts`): an Atom feed with one entry
per release (orchestrator-generated text only, like the README section),
a sitemap listing the front page and `/loop/` only (item pages churn every
15 minutes and mirror HN comments), and the current release's `preview.png`
(falling back to `index-1280.png`), which is the fixed `Spec.previewHref`
every rendered page's `og:image` points at. Files in `site/verify/*.html`
(search-engine ownership verification) are copied to the root as-is; they
are human-committed and outside the bot-editable paths. There is no `robots.txt`:
crawlers read it only at the host root, which a project Pages site does not
control.

The local tier-2 server serves the site under the same prefix and 404s
unprefixed paths, so a wrong href fails locally exactly as it would on Pages.

## Baseline check

`npm run cli -- baseline --fixtures fixtures/baseline/<ts> [--out report.json]`
(`orchestrator/src/baseline.ts`, run by `baseline.yml` once per spec
version): fetches the fixture's 30 story ids and their comment trees from
the API now, renders them with the proven binary, and compares against the
fixture HTML. Only what is stable across the time gap is a FAIL: title and
author text, the presence of a comments link (jobs have none), each common
comment's parent, a page that parses to nothing, a missing story. WARN:
HN's site string (HN strips subdomains and appends a path on multi-user
hosts; `Spec.domainOf` keeps the host), an id the API no longer has,
comments HN shows that we lack (deleted since, or the per-story cap). INFO:
comments we have that HN lacks, sibling order (HN ranks by votes), and the
fixture's overlap with the live top 30. Scores, counts, ages and hrefs are
not compared. `report.json` is committed with the fixture; the command
exits 1 on any FAIL.

