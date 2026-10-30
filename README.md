# hn-formal

**Live: [scasella.github.io/hn-formal](https://scasella.github.io/hn-formal/)**. The Hacker News front page, redesigned every night by an AI and proven in Lean 4 to render the data correctly before it ships, with no human review. How it works and every generation: [the loop page](https://scasella.github.io/hn-formal/loop/). Follow new generations by [Atom feed](https://scasella.github.io/hn-formal/feed.xml) or by watching this repo's [releases](https://github.com/scasella/hn-formal/releases) (Watch, then "Releases only").

<!-- generation:start -->
## Current generation

[![Front page of generation 20261030-103551-182f5cb at 1280px](releases/20261030-103551-182f5cb/index-1280.png)](https://scasella.github.io/hn-formal/)

Generation `20261030-103551-182f5cb` (2026-10-30 10:35 UTC) · brief "cards on a grid" · judge 81/100 · novelty 78 · spec v3 · new DOM · 1 repair round · $0.09 · [report](releases/20261030-103551-182f5cb/report.json)

### Previous generations

<p>
<a href="releases/20261028-101156-bb5e5af/"><img src="releases/20261028-101156-bb5e5af/index-375.png" width="120" alt="Generation 20261028-101156-bb5e5af, judge 79"></a>
<a href="releases/20261027-093319-65e849f/"><img src="releases/20261027-093319-65e849f/index-375.png" width="120" alt="Generation 20261027-093319-65e849f, judge 79"></a>
<a href="releases/20261026-093712-25d81bd/"><img src="releases/20261026-093712-25d81bd/index-375.png" width="120" alt="Generation 20261026-093712-25d81bd, judge 79"></a>
<a href="releases/20261025-085139-c456f17/"><img src="releases/20261025-085139-c456f17/index-375.png" width="120" alt="Generation 20261025-085139-c456f17, judge 74"></a>
<a href="releases/20261024-083653-21d015c/"><img src="releases/20261024-083653-21d015c/index-375.png" width="120" alt="Generation 20261024-083653-21d015c, judge 75"></a>
<a href="releases/20261021-090026-676c413/"><img src="releases/20261021-090026-676c413/index-375.png" width="120" alt="Generation 20261021-090026-676c413, judge 82"></a>
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

1. The loop authenticates with Workload Identity Federation: each job
   exchanges its GitHub OIDC token for a short-lived Anthropic token, so
   there is no API key secret. Setup is in the Console's Workload identity
   page (issuer `https://token.actions.githubusercontent.com`, discovery
   JWKS; rule `hn-formal-redesign` matching subject
   `repo:scasella@11952600/hn-formal@1411038814:ref:refs/heads/main` (the
   repo uses GitHub's immutable, ID-based subject format) plus the `ref`,
   `repository`, `repository_owner` and `repository_owner_id` claims,
   targeting service account `hn-formal-ci` in the Default workspace; a
   workspace spend limit there is a second cap behind the orchestrator's
   `RUN_CAP_USD` / `MONTH_CAP_USD`). The rule, organization,
   service account and workspace IDs go in the repository variables
   `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
   `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID`. If
   authentication fails the daily `redesign` run records a failure on the
   dashboard; commit an empty `KILL_SWITCH` file at the repo root to pause
   every workflow instead.
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
