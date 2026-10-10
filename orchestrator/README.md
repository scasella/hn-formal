# orchestrator

TypeScript CLI for the hn-formal loop: fetch HN data, run redesign candidates
through the Lean build and the browser checks, judge, release, roll back.
Binding interface: [`../CONTRACT.md`](../CONTRACT.md).

```
cd orchestrator
npm install
npx playwright install chromium     # once per machine / CI job
npm run cli -- <command> [options]
npm run typecheck
npm test
```

Node 20+ (developed on 25). Java is needed for vnu (`tier2`). The Lean
toolchain is needed only by `candidate`/`redesign`; those take the binary from
`HNFORMAL_BIN` and can be exercised without Lean (see Testing).

Every command first checks for `KILL_SWITCH` at the repo root and exits 0
printing `paused` when it exists.

## Commands

### `fetch --out data/latest.json [--cache orchestrator/.cache/items]`

HN Firebase API only (`/v0/topstories.json`, `/v0/item/{id}.json`). Takes the
first 30 live ids (if an item is null it takes the next id so `top` always has
exactly 30), fetches each item, walks `kids` (and poll `parts`)
breadth-first per story with a count cap and a depth cap. Items are cached on
disk by id with a TTL so repeated runs are mostly delta (a re-run inside the
TTL is one request). Comments older than 24h use a longer TTL. Concurrency 16,
retries with backoff on 429/5xx/network errors. Output is exactly the CONTRACT
data JSON (`fetchedAt`, `top`, `items`), items passed through unchanged.

### `candidate --n <i> --run <runId> [--data data/latest.json] [--rounds 10] [--out runs/<runId>/cand-<i>.json] [--candidates 16]`

One candidate's generate + repair loop, CONTRACT "Candidate protocol":

1. Copies the working tree (minus `.lake`, `node_modules`, `.git`, `out`,
   `runs`, `releases`, `.cache`) into a scratch dir (`CANDIDATE_WORKDIR` or a
   temp dir; `COPY_LAKE=1` includes `.lake` so the library is not rebuilt).
2. Asks the model for `{ renderLean, styleCss, designNotes }` (structured
   output, streamed, `max_tokens` 32000) and writes the two files.
3. `scripts/css-lint.sh site/style.css` (or the built-in equivalent when the
   script is absent; the built-in lint always runs as well), `lake build`,
   `scripts/axiom-check.sh`, `hnformal selftest`, `hnformal render`, then
   tier 2 on the rendered site (style.css and fonts are copied next to it).
4. Any failure feeds the failing stage's output (tail, ~12K chars) back as the
   next round's user message, up to `--rounds`.
5. On a pass: screenshots + judge (never blocks), files and screenshots kept
   under `runs/<runId>/cand-<i>/`.

Each round is a fresh single-turn conversation (previous files + failure in
one user message) rather than an accumulating chat; this keeps every request
under the 100K-token price cliff and avoids the Haiku 5.5 edited-history
check on thinking blocks. The stable prefix (instructions + `HnFormal/*.lean`
+ the current `Render.lean` and `style.css` as the worked example) is one
`cache_control` system block, byte-identical for every candidate and round of
a run; the per-candidate design brief is a second, uncached system block.
Briefs: `briefs[n % 24]` in `src/prompts.ts`.

Writes `runs/<runId>/cand-<i>.json` (CONTRACT `perCandidate` fields plus
`roundLog`, `tier1Detail`, `tier2Report`, `renderLean`, `styleCss`,
`screenshots`, `costUsd`, `calls`, `stopReason` in
`passed|failed|cap-hit|killed|error`). Exit code is 0 unless the process
crashed; a failed candidate is a normal result.

### `tier2 --site out/ --out report.json [--all-pages]`

Playwright + Chromium over a local static server rooted at `--site`. The server
strips the Pages prefix `SITE_PREFIX` (default `/hn-formal`) so root-relative
links such as `/hn-formal/style.css` resolve, and every page is opened at
`http://127.0.0.1:<port>/hn-formal/<page>`, exactly as it will be on Pages:

- vnu.jar on every html file (downloaded to `orchestrator/.cache/vnu.jar` on
  first use; `VNU_JAR` to point at an existing jar): zero errors.
- axe-core (`@axe-core/playwright`) on index.html and 3 item pages: zero
  serious/critical violations.
- contrast: every visible text node, computed color over the composited
  ancestor backgrounds (white if transparent all the way; alpha and opacity
  blended). 4.5:1, or 3:1 for >= 24px or bold >= 18.66px. Text over a
  `background-image` (gradients included) cannot be computed and fails.
  Overlapping siblings (text over a positioned element) are not considered.
- reflow: `max(documentElement.scrollWidth, body.scrollWidth) <= 375` at a
  375px viewport.
- CSP simulation: no `<script>`, no `on*=` handlers, no `javascript:` URLs,
  no foreign-origin resources (`<link>`, `<img>`, media), no foreign `url()`
  or `url()` outside `/fonts/` or `@import` in any stylesheet. Inline `style`
  attributes and `<style>` elements are logged as warnings only.

Output: `{ ok, tier2: {vnu, axe, contrastMin, reflowWidth, csp}, failures: [{check, page, message}], pages }`.
Exit 0 when ok, 1 otherwise.

### `judge --site out/ --out judge.json [--shots <dir>]`

Screenshots index.html at 1280 and 375 and the first item page at 1280 (viewport-clipped, 2000/2400px tall; saved with the CONTRACT names `index-1280.png`, `index-375.png`, `item-1280.png`), sends them to `claude-haiku-5-5` with the rubric in `src/prompts.ts` (readability, hierarchy, scannability, taste) and writes `{ score 0-100 | null, notes, costUsd, calls, screenshots }`. Never throws; a failed judge yields `score: null`.

### `aggregate --run <runId> [--dir runs/<runId>/] [--no-release]`

Reads `cand-*.json`, writes the CONTRACT run record `runs/<runId>.json`,
updates `runs/index.json` (array of run summaries, newest first), records the
run's spend in the month ledger, picks the tier1+tier2 passer with the
highest judge score (null scores last, ties to the lowest `n`), and calls
release for it. `stopReason`: `released`, else `cap-hit` if any candidate hit
a cap, else `killed`, else `no-passer`.

### `release --from runs/<runId>/cand-<i>.json`

Creates `releases/<YYYYMMDD-HHMMSS>-<shortsha>/` with `Render.lean`,
`style.css`, `report.json` and the three pngs, prepends the report to
`releases/index.json`, and copies the two editable files into
`HnFormal/Render.lean` and `site/style.css`. Prints the paths. Does not
commit. `repairRounds` is rounds minus one; `diffStat` is `git diff --numstat`
of both files against what was in place; `previousRelease` is the previous
head of `releases/index.json`; `specVersion` from `SPEC_VERSION` (default 1).

### `rollback <releaseId>`

Copies that release's two files into place and prints the paths. No commit.

### `redesign [--run <runId>] [--candidates 16] [--rounds 10] [--parallel 1] [--data data/latest.json]`

Local all-in-one: fetches if the data file is missing, runs the candidates
in-process (sequentially or `--parallel N`), then `aggregate`.

### `spend --month [YYYY-MM]`

Prints month-to-date spend from `runs/spend-YYYY-MM.json`.

## Guardrails (CONTRACT)

- `KILL_SWITCH` at the repo root: every command exits 0 with `paused`;
  a running candidate checks it between rounds and stops with `killed`.
- Spend caps: `RUN_CAP_USD` (25), `MONTH_CAP_USD` (400), `MAX_CALLS` (200).
  In CI the 16 candidates are separate jobs with no shared state, so each
  candidate enforces its share: `CANDIDATE_CAP_USD` (default
  `RUN_CAP_USD / --candidates`) and `MAX_CALLS_PER_CANDIDATE` (default
  `ceil(MAX_CALLS / --candidates)`). The month cap is checked against the
  committed ledger at start and against ledger + own spend before every call.
- Cost is computed from `usage` on every response at Claude Haiku 5.5 list
  prices: $0.10/$0.50 per MTok in/out for prompts <= 100K tokens, $0.50/$2.50
  above; cache reads 0.1x input, 5-minute cache writes 1.25x, 1-hour writes
  2x (`src/anthropic.ts`, `costOf`). The tier is chosen per request from
  `input + cache_read + cache_creation` tokens.
- The cached prefix is counted once per process with `messages.countTokens`;
  the candidate refuses to start above `PREFIX_MAX_TOKENS` (90000) and warns
  above `PREFIX_WARN_TOKENS` (60000). A round whose estimated prompt exceeds
  100K is not sent (`ALLOW_OVER_100K=1` overrides).
- `stop_reason` is checked on every response: `refusal` and `max_tokens`
  (and unparseable structured output) are failed rounds that still count
  toward spend. There is no server-side fallback on Haiku.
- The API key is read by the SDK from `ANTHROPIC_API_KEY` and never printed;
  error output passes through a redactor.
- Month ledger `runs/spend-YYYY-MM.json` (written atomically):
  `{ month, totalUsd, calls, runs: { <runId>: { costUsd, calls, perCandidate: { <n>: { costUsd, calls } } } }, updatedAt }`.
  Candidates write their own entry (idempotent per run+n); `aggregate`
  rewrites the run's entries from the cand files, which is the authoritative
  write in CI (candidate jobs do not commit).

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | all model calls (SDK) |
| `ANTHROPIC_MOCK` | – | `1` = canned model output from `test/mock/*.json` (no network) |
| `ANTHROPIC_MOCK_CANDIDATE`, `ANTHROPIC_MOCK_JUDGE` | `test/mock/candidate.json`, `test/mock/judge.json` | mock file overrides |
| `HNFORMAL_MODEL` | `claude-haiku-5-5` | generation and judge |
| `GENERATE_EFFORT`, `JUDGE_EFFORT` | `xhigh`, `low` | `output_config.effort` (adaptive thinking depth) |
| `GENERATE_MAX_TOKENS` | `120000` | generation `max_tokens` (thinking counts against it) |
| `STRUCTURE_ROUNDS` | `2` (`0` in mock mode) | rounds during which an unchanged DOM or a missing brief move is a soft failure (CONTRACT steps 7-8); `0` disables |
| `SITE_URL` | `https://scasella.github.io/hn-formal/` | README generation section links; feed and sitemap URLs (`site-extras`) |
| `CACHE_TTL` | `1h` | `5m` or `1h` cache_control TTL on the prefix |
| `PREFIX_MAX_TOKENS`, `PREFIX_WARN_TOKENS` | `90000`, `60000` | prefix size guard |
| `ALLOW_OVER_100K` | – | `1` sends rounds estimated above the price cliff |
| `RUN_CAP_USD`, `MONTH_CAP_USD`, `MAX_CALLS` | `25`, `400`, `200` | caps |
| `CANDIDATE_CAP_USD`, `MAX_CALLS_PER_CANDIDATE` | run cap / candidates | per-candidate share |
| `CANDIDATES` | `16` | default `--candidates` (also for `judge`) |
| `REPO_ROOT` | parent of `orchestrator/` | where `KILL_SWITCH`, `runs/`, `releases/`, `HnFormal/`, `site/` live |
| `ORCH_CACHE_DIR` | `orchestrator/.cache` | item cache and vnu.jar |
| `HNFORMAL_BIN` | `lake exe hnformal` | the Lean executable |
| `LAKE_BUILD_CMD` | `lake build` | stage 3 |
| `CSS_LINT_CMD` | `sh scripts/css-lint.sh site/style.css` (or built-in) | stage 2 |
| `AXIOM_CHECK_CMD` | `sh scripts/axiom-check.sh` | stage 4 (fails if the script is missing) |
| `SELFTEST_CMD` | `$HNFORMAL_BIN selftest` | stage 5 |
| `RENDER_CMD` | `$HNFORMAL_BIN render {data} {out}` | stage 6 (`{data}`/`{out}` substituted) |
| `STAGE_TIMEOUT_SECONDS`, `LAKE_BUILD_TIMEOUT_SECONDS`, … | `900`, `3600` | per-stage timeouts |
| `CANDIDATE_WORKDIR` | temp dir | scratch copy location (kept when set) |
| `COPY_LAKE` | – | `1` copies `.lake` into the scratch dir |
| `KEEP_WORKDIR` | – | `1` keeps the temp scratch dir |
| `MAX_COMMENTS_PER_STORY`, `MAX_DEPTH` | `400`, `50` | fetch caps |
| `ITEM_TTL_SECONDS`, `OLD_ITEM_TTL_SECONDS` | `900`, `86400` | item cache TTLs |
| `FETCH_CONCURRENCY` | `16` | fetch |
| `SITE_PREFIX` | `/hn-formal` | `tier2`, `judge` (and `candidate`/`redesign` through them): Pages path prefix the local static server strips (`/hn-formal/style.css` -> `<site>/style.css`; unprefixed paths still served) and the pages are opened under; normalized to leading slash, no trailing slash; set to the empty string for a root-served site |
| `VNU_JAR`, `VNU_URL` | `.cache/vnu.jar`, validator "latest" release | tier2 |
| `SPEC_VERSION` | `1` | release report |

## Layout

```
src/cli.ts         entry: argument parsing and dispatch
src/anthropic.ts   client, pricing, cost accounting, structured calls, mock mode
src/prompts.ts     system prompt, briefs, RENDER_SIGNATURE etc., judge rubric
src/guardrails.ts  kill switch, caps, Budget, spend ledger, redaction
src/hn.ts          Firebase client with disk cache and BFS
src/fetch.ts       fetch command + data shape validation
src/candidate.ts   candidate loop, tier-1 pipeline, built-in css lint
src/tier2.ts       vnu / axe / contrast / reflow / csp
src/browser/*.js   scripts evaluated inside the page (plain JS on purpose)
src/judge.ts       screenshots + vision judge
src/aggregate.ts   run record, winner selection
src/release.ts     release + rollback
src/redesign.ts    local all-in-one
src/spend.ts       month report
src/server.ts      static server for the browser checks
src/types.ts       CONTRACT shapes
test/fixture-site  a tiny hand-written site that passes tier 2
test/fake-hnformal.sh  stand-in binary: selftest ok, render copies the fixture
test/mock/*.json   canned model outputs for ANTHROPIC_MOCK=1
```

## Testing without Lean or an API key

```
# tier2 and judge against the fixture (judge mocked)
npm run cli -- tier2 --site test/fixture-site --out /tmp/t2.json
ANTHROPIC_MOCK=1 npm run cli -- judge --site test/fixture-site --out /tmp/judge.json

# full candidate -> aggregate -> release -> rollback chain in a scratch repo
export REPO_ROOT=/tmp/hn-scratch ANTHROPIC_MOCK=1 \
  HNFORMAL_BIN=$PWD/test/fake-hnformal.sh LAKE_BUILD_CMD="echo ok" \
  AXIOM_CHECK_CMD="echo \"'HnFormal.Render.render_ok' depends on axioms: [propext, Classical.choice, Quot.sound]\""
mkdir -p $REPO_ROOT/HnFormal $REPO_ROOT/site $REPO_ROOT/data
npm run cli -- fetch --out $REPO_ROOT/data/latest.json
npm run cli -- candidate --n 0 --run T1 --rounds 3 --candidates 2
npm run cli -- aggregate --run T1
npm run cli -- rollback <releaseId>
npm run cli -- spend --month
npx tsx test/probe-auth.ts    # does the SDK find credentials?
```

The mock candidate fails css-lint in round 1 (a `content: "oops"` rule) and
passes in round 2, so the repair path is exercised.
