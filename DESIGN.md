# hn-formal: design decisions

Status: agreed in grilling session, 2026-10-08. v0 built the same day; see
"What the build changed" at the end.

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

Trusted base, published on the site: the Lean kernel (checks the proof), the
Lean compiler and runtime (the kernel checks the proof about the source; the
compiled binary is what produces the bytes), Lean's JSON decoder into the
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
  the gallery. Ties go to a candidate whose rendered DOM differs from the
  current site's (class attributes ignored): the first 16-candidate run
  (2026-10-09) produced fifteen CSS-only restyles of one DOM, so a candidate
  that passes with an unchanged DOM is sent back for structure during its
  first two rounds, with the restyle kept as a fallback that ships if no
  structural attempt passes.
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

## What the build changed (2026-10-08)

Writing the proof forced four spec decisions that the grilling did not reach:

- **Blank titles and authors.** The API can return a blank title or author.
  An anchor with blank text violates the accessibility rule, so the spec now
  requires `displayTitle` / `displayUser` (the value, or "untitled" /
  "anonymous" when blank). Both are listed as derived text.
- **No string concatenation in text nodes.** The content gate checks each
  text node; a renderer that wants "Title | HN, formally" emits adjacent
  text nodes, which serialize to the same bytes. Documented in Spec.lean.
- **Blank-text links in comments.** A user comment can contain
  `<a href="…"></a>`. The sanitizer gives such links the fixed text "link"
  and unwraps links with unsafe schemes into a `span`; its theorem now
  guarantees every emitted anchor is named.
- **Href percent-encoding.** A real comment contained a URL with `[`, which
  the HTML validator rejects. The sanitizer and `titleHref` percent-encode
  characters that are not URL code points. The public claim is "faithful to
  the API, with hrefs percent-encoded where the URL standard requires it".

Proof engineering facts the loop depends on: `Render.lean` must start with
`set_option maxHeartbeats 2000000` and `set_option maxRecDepth 4096`; the
library tactic `hn_auto` discharges all-nodes goals; `hn_decide` is kernel
`decide` restricted to closed goals; `native_decide` is rejected by the axiom
check. A full `lake build` of a candidate takes about 45 s on a laptop.

## Spec version 2 (2026-10-09)

Every page carries a one-sentence explanation as a single text node in an
element marked `data-hn="about"`, placement free:

> An AI redesigns the Hacker News front page every night. Each design is
> proven in Lean 4 to render the data correctly before it ships, with no
> human review.

Requested by the user; made a spec requirement so no redesign can drop it.
