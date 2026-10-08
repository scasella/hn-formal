# hn-formal: design decisions

Status: agreed in grilling session, 2026-10-08. Not yet built.

## The claim

"HN, formally" is an unofficial, read-only rendering of the Hacker News front
page and its 30 discussion threads, produced by a renderer that is **proven in
Lean 4 to render every possible HN API input correctly**, redesigned
autonomously by an LLM loop, and released without human review whenever a
candidate passes.

Two tiers, labeled honestly on the site:

- **Tier 1, proven (Lean kernel, no `native_decide`, no extra axioms):**
  structure (30 items, API rank order, each item's title/url/domain/points/
  author/age/comments link, "More" link), full comment tree at any depth with
  parent/child nesting preserved, data fidelity to the API, landmark/heading/
  link-name structure, no injection (verified allowlist parser for the API's
  HTML fragment: p, a, i, code, pre, br, entities), **content gate** (every
  text node in the rendered tree is a substring of the API payload or a member
  of the fixed allowlist of nav/footer strings), and a proven DOM-to-HTML
  serializer so the bytes encode exactly the proven tree.
- The Item type covers all five API types (job, story, comment, poll,
  pollopt) with optional fields; `topstories` includes jobs (no `by`, `score`,
  `descendants`) and occasionally polls (`parts`). The proof quantifies over
  all of them.
- **Tier 2, checked per release in a browser:** contrast ratio, reflow at
  375px, vnu validation, axe. Never called "proven".

Trusted base, published on the site: Lean kernel, Lean's JSON decoder into the
Item type, the fetcher, GitHub Actions, the OS. Everything else is proven.

Public fidelity claim: faithful to `topstories[0:30]` and `item/{id}` at render
time. Not a claim about matching HN's displayed order (it drifts).

## What is fixed and what is free

- Fixed: data, semantics, link behavior, accessibility structure.
- Free: everything else. The LLM may drop the list metaphor entirely.
- Design unit the loop may edit: `Render.lean` + `style.css`. Nothing else.
  CI fails on any diff outside those paths.
- No JS (CSP `script-src 'none'`), no external origins, fonts from a fixed
  self-hosted allowlist. A CI lint on `style.css` rejects any non-empty
  `content:` string (pseudo-element text would bypass the proven DOM) and any
  `url(` outside the font allowlist. Interactive affordances (vote, reply, login,
  collapse, new/ask/show/jobs) are links to news.ycombinator.com.
- Spec is human-authored (`Spec.lean`), frozen per version, LLM read-only.
  Spec changes: PR, version bump, baseline re-run, re-verify prior releases.

## The loop

- Model: `claude-haiku-5-5` via the Anthropic SDK (TypeScript orchestrator).
  Keep the cached prefix (spec + library + instructions) under 100K tokens.
  No server-side refusal fallback exists on Haiku; handle `stop_reason`.
- Per run: 16 candidates in parallel (a 16-job Actions matrix), each up to 10
  repair rounds fed by Lean error output. Hard call cap per run so no run
  exceeds $25. At Haiku prices 160 calls is a few dollars; the binding
  constraint is Lean build time inside the 6-hour job limit, not money.
- Cadence: one redesign run per day. Spend caps: $25/run, $400/month,
  enforced in the orchestrator and again by a dedicated Console workspace
  limit. Auth: `ANTHROPIC_API_KEY` as a GitHub Actions secret.
- Release: among tier-1 and tier-2 passers, a vision judge
  (`claude-haiku-5-5`, scoring Playwright screenshots from the same tier-2
  run) ranks; the top one ships. The judge never blocks. All passers go in
  the gallery.
- Failure: cap exhausted with no passer means no release, prior build stays,
  run logged publicly as failed.
- Guardrails: spend cap, iteration cap, kill switch, one-command rollback to
  any prior release, content gate (no copy beyond API data plus a fixed
  allowlist of nav/footer strings).

## Data and deployment

- Source: HN Firebase API only (`/v0/topstories`, `/v0/item/{id}`). Item JSON
  cached by id with short TTL so refreshes are mostly delta; the cache lives
  on a `data` branch the refresh job commits to (actions/cache evicts after
  7 days and is not a store). Comment trees
  fetched to a declared practical cap; the proof covers arbitrary depth.
- Refresh: every 15 minutes, static regeneration by the compiled Lean binary.
  The proven program is exactly what produced the bytes.
- Hosting: GitHub Actions + GitHub Pages at the default URL. Lean via
  lean-action with `.lake` cache.
- Baseline check against real HN: manual workflow only, once per spec
  version, fetched HTML committed as a timestamped fixture. Never scheduled.

## Public face

- The clone, plus a fixed human-designed dashboard: releases, Lean output,
  axe reports, judge scores, diffs, failed runs, spec version, trusted-base
  list.
- Name: hn-formal. Site title "HN, formally". Footer: unofficial, not
  affiliated with Y Combinator; link to the original on every page; no Y logo.
- Repo: public from the first commit, Apache-2.0.

## Known risks accepted

- Haiku 5.5 may close fewer Lean proofs per attempt than Opus; volume is the
  bet. Escalation to Opus for stuck proofs was considered and declined.
- Correct-but-ugly releases will happen and are part of the premise.
- `topstories` drift means the page is never byte-identical to HN's order.
- GitHub scheduled workflows are best-effort (often late) and are disabled in
  a public repo after 60 days without commits. Daily releases and data-branch
  commits keep it alive; a failed-run commit covers days with no passer.
