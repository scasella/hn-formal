# Interface contract

Three parts, built in parallel. This file is the agreement between them.
Change it only with a commit that touches all affected parts.

## Repo layout

```
HnFormal/            Lean library (spec, dom, sanitizer, serializer, item types)
HnFormal/Render.lean LLM-EDITABLE: the renderer + its proof
Main.lean            Lean executable entry (`hnformal`)
lakefile.toml, lean-toolchain
site/style.css       LLM-EDITABLE: the stylesheet
site/fonts/          fixed self-hosted font allowlist (may be empty)
dashboard/           fixed human-designed loop dashboard (static HTML+JS, reads JSON)
orchestrator/        TypeScript CLI (fetch, candidates, tier2, judge, release)
releases/            one dir per release, see below; releases/index.json
runs/                one JSON per redesign run (passed or failed); runs/index.json
fixtures/baseline/   manually fetched HN HTML + timestamp, for the baseline check
.github/workflows/   refresh.yml, redesign.yml, baseline.yml, pages.yml, ci.yml
scripts/             css-lint, axiom-check, misc shell
```

The only paths a candidate may change: `HnFormal/Render.lean`, `site/style.css`.
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
top ids. Every page links the stylesheet as `/style.css` (absolute from site
root) and nothing else external. Exit 0 on success, 2 on malformed data JSON.

```
hnformal check <data.json>
```
Runs the decidable form of the spec on the pages it would render and prints
`ok` or the first violated predicate name. Exit 0/1. (Sanity only; the
theorem in Render.lean is the real guarantee.)

```
hnformal selftest
```
Renders built-in fixtures (including jobs, polls, deleted/dead comments, deep
trees, hostile HTML) and runs `check` on them. Exit 0/1.

## Candidate protocol (orchestrator <-> Lean)

A candidate is `{ renderLean: string, styleCss: string }`. To evaluate:

1. Write both files into a clean checkout of main.
2. `scripts/css-lint.sh site/style.css`  (no non-empty `content:`, no `url(`
   outside `/fonts/`, no `@import`). Exit 1 = fail with reason on stdout.
3. `lake build` (exit != 0 => tier-1 fail; stderr is the repair signal).
4. `scripts/axiom-check.sh` runs `lake env lean scripts/Axioms.lean` which
   does `#print axioms HnFormal.Render.render_ok` and fails if the set is not a
   subset of {propext, Classical.choice, Quot.sound}. Fail = tier-1 fail.
5. `lake exe hnformal selftest` (must pass; defense in depth).
6. `lake exe hnformal render data/latest.json out/` then tier 2 on `out/`.

Tier 2 (orchestrator, Playwright + Chromium):
- vnu.jar on every html file: zero errors.
- axe-core on index.html and 3 item pages: zero violations of impact
  serious/critical.
- contrast: every text node's computed fg/bg >= 4.5:1 (3:1 for >= 24px).
- reflow: at 375px viewport, document.scrollWidth <= 375.
- CSP header simulated: no inline script, no <script>, no external origins
  in computed stylesheet (belt and braces over css-lint).

Judge (orchestrator): `claude-haiku-5-5` with screenshots (1280px and 375px
of index.html, 1280px of one item page). Returns `{ score: 0-100, notes }`.
Never blocks.

## Release record

`releases/<YYYYMMDD-HHMMSS>-<shortsha>/`:
```
Render.lean  style.css  report.json  index-1280.png  index-375.png  item-1280.png
```
`report.json`:
```json
{ "id": "20261009-031500-ab12cd3", "runId": "...", "specVersion": 1,
  "tier1": { "lakeBuild": "ok", "axioms": ["propext","Classical.choice","Quot.sound"], "selftest": "ok" },
  "tier2": { "vnu": 0, "axe": 0, "contrastMin": 4.7, "reflowWidth": 375, "csp": "ok" },
  "judge": { "score": 71, "notes": "..." },
  "model": "claude-haiku-5-5", "repairRounds": 3, "costUsd": 0.42,
  "previousRelease": "...", "diffStat": "+120 -84" }
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
  "perCandidate": [ { "n": 0, "rounds": 4, "tier1": "ok|fail:<stage>", "tier2": "ok|fail:<check>", "judge": 71, "lastError": "..." } ] }
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
`/loop/releases.json` and `/loop/runs.json` (copies of the two index files
made at deploy time) and renders: current release, gallery of all releases
with screenshots and scores, run history incl. failures, spec version,
trusted-base list (static text), link to repo.

## Site layout on Pages

```
/index.html  /item/<id>.html  /style.css  /fonts/*  /loop/*  /spec/Spec.lean (copy)
```
