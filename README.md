# hn-formal

**Live: [scasella.github.io/hn-formal](https://scasella.github.io/hn-formal/)**. The Hacker News front page, redesigned every night by an AI and proven in Lean 4 to render the data correctly before it ships, with no human review. How it works and every generation: [the loop page](https://scasella.github.io/hn-formal/loop/). Follow new generations by [Atom feed](https://scasella.github.io/hn-formal/feed.xml) or by watching this repo's [releases](https://github.com/scasella/hn-formal/releases) (Watch, then "Releases only").

<!-- generation:start -->
## Current generation

[![Front page of generation 20261018-082808-93ddb04 at 1280px](releases/20261018-082808-93ddb04/index-1280.png)](https://scasella.github.io/hn-formal/)

Generation `20261018-082808-93ddb04` (2026-10-18 08:28 UTC) · brief "timeline" · judge 76/100 · novelty 78 · spec v3 · new DOM · 1 repair round · $0.11 · [report](releases/20261018-082808-93ddb04/report.json)

### Previous generations

<p>
<a href="releases/20261017-081535-9c6c081/"><img src="releases/20261017-081535-9c6c081/index-375.png" width="120" alt="Generation 20261017-081535-9c6c081, judge 77"></a>
<a href="releases/20261016-084302-5fb92f2/"><img src="releases/20261016-084302-5fb92f2/index-375.png" width="120" alt="Generation 20261016-084302-5fb92f2, judge 78"></a>
<a href="releases/20261015-084434-ad078f4/"><img src="releases/20261015-084434-ad078f4/index-375.png" width="120" alt="Generation 20261015-084434-ad078f4, judge 77"></a>
<a href="releases/20261014-090859-dedb9cc/"><img src="releases/20261014-090859-dedb9cc/index-375.png" width="120" alt="Generation 20261014-090859-dedb9cc, judge 76"></a>
<a href="releases/20261012-112524-c324d41/"><img src="releases/20261012-112524-c324d41/index-375.png" width="120" alt="Generation 20261012-112524-c324d41, judge 82"></a>
<a href="releases/20261011-102555-55b9036/"><img src="releases/20261011-102555-55b9036/index-375.png" width="120" alt="Generation 20261011-102555-55b9036, judge 77"></a>
</p>

Every generation, with its proof, stylesheet, report and screenshots, is under [releases/](releases/). Run history is on the [dashboard](https://scasella.github.io/hn-formal/loop/). This section is rewritten by the release step; see CONTRACT.md.
<!-- generation:end -->

**HN, formally.** An unofficial, read-only rendering of the Hacker News front
page and its discussion threads, produced by a renderer proven in Lean 4 to
render every possible HN API input correctly, redesigned autonomously by an
LLM loop, and released without human review whenever a candidate passes.

Not affiliated with Y Combinator. The original is at https://news.ycombinator.com.

See [DESIGN.md](DESIGN.md) for the agreed design, the two-tier claim, and the
trusted base; [CONTRACT.md](CONTRACT.md) for how the pieces fit.

## Status

- `HnFormal/Spec.lean` is the spec (version 2). `HnFormal/Render.lean` is
  whatever the loop last released, with its proof `render_ok`, which depends
  only on `propext`, `Classical.choice`, `Quot.sound`.
- The front page and all 30 threads render from live API data every 15
  minutes and pass both the executable check and the tier-2 browser suite.
- The loop (`orchestrator/`, `.github/workflows/redesign.yml`) runs daily;
  every release is under `releases/`, every run under `runs/`, both on the
  dashboard. The section above is rewritten by each release.

## Operating the loop

1. The loop needs the repository secret `ANTHROPIC_API_KEY`: a key from a
   dedicated Anthropic Console workspace with its own spend limit (a second
   cap behind the orchestrator's `RUN_CAP_USD` / `MONTH_CAP_USD`). Without it
   the daily `redesign` run records a failure on the dashboard; commit an
   empty `KILL_SWITCH` file at the repo root to pause every workflow instead.
2. To validate a change to the loop before the cron: dispatch `redesign` with
   small `candidates` and `rounds` inputs. It releases exactly like a
   scheduled run, so the live design changes if a candidate passes.
3. `refresh` runs every 15 minutes and deploys to GitHub Pages
   (https://scasella.github.io/hn-formal/). `redesign` runs daily at 03:17 UTC.
   `baseline` is manual only.
4. Rollback: `npm --prefix orchestrator run cli -- rollback <releaseId>`, then
   commit the two restored files and the README.

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
