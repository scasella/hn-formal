# hn-formal

**HN, formally.** An unofficial, read-only rendering of the Hacker News front
page and its discussion threads, produced by a renderer proven in Lean 4 to
render every possible HN API input correctly, redesigned autonomously by an
LLM loop, and released without human review whenever a candidate passes.

Not affiliated with Y Combinator. The original is at https://news.ycombinator.com.

See [DESIGN.md](DESIGN.md) for the agreed design, the two-tier claim, and the
trusted base; [CONTRACT.md](CONTRACT.md) for how the pieces fit.

## Status

- `HnFormal/Spec.lean` is the spec (version 1). `HnFormal/Render.lean` is the
  v0 renderer with its proof `render_ok`, which depends only on `propext`,
  `Classical.choice`, `Quot.sound`.
- The front page and all 30 threads render from live API data and pass both
  the executable check and the tier-2 browser suite.
- The loop (`orchestrator/`, `.github/workflows/redesign.yml`) is wired but
  needs an `ANTHROPIC_API_KEY` repository secret before its first run.

## Operating the loop

1. In the Anthropic Console, create a dedicated workspace with a spend limit
   (a second cap behind the orchestrator's own `RUN_CAP_USD` / `MONTH_CAP_USD`)
   and an API key in it. Add the key as the repository secret
   `ANTHROPIC_API_KEY`. Until it exists, the daily `redesign` run records a
   failed run on the dashboard every day; commit an empty `KILL_SWITCH` file
   at the repo root to pause every workflow instead.
2. First real run, before trusting the cron: dispatch `redesign` with
   `candidates=1`, `rounds=2`, then confirm in the job log that round 2 shows
   `cache_read_input_tokens > 0` and that the recorded cost matches the
   Console. No live Claude call has been exercised yet; every Claude path
   was tested with a mock.
3. `refresh` runs every 15 minutes and deploys to GitHub Pages
   (https://scasella.github.io/hn-formal/). `redesign` runs daily at 03:17 UTC.
   `baseline` is manual only.
4. Rollback: `npm --prefix orchestrator run cli -- rollback <releaseId>`, then
   commit the two restored files.

## Build and run

```bash
lake build && lake exe hnformal selftest
```

```bash
npm --prefix orchestrator ci && npm --prefix orchestrator run cli -- fetch --out data/latest.json
```

```bash
lake exe hnformal render data/latest.json out && lake exe hnformal check data/latest.json
```

Lean 4.34.1 via elan; Node 22+; Java for the HTML validator; Playwright
Chromium for tier 2 (`npx playwright install chromium` inside `orchestrator/`).

License: Apache-2.0.
