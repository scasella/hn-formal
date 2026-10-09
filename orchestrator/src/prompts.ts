import fsp from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { SystemBlocks } from "./anthropic.js";
import { CACHE_TTL } from "./anthropic.js";
import { EDITABLE_FILES, fromRepo } from "./paths.js";
import { exists, log, tail } from "./util.js";

// ---------------------------------------------------------------------------
// Names quoted verbatim in the instructions. Confirmed against
// HnFormal/Render.lean and scripts/axiom-check.sh (2026-10-08). The library
// sources themselves are read from HnFormal/*.lean at runtime, so only these
// constants need updating if the lead renames something.
// ---------------------------------------------------------------------------

/** Fully qualified name and type of the renderer the candidate must define. */
export const RENDER_SIGNATURE = "HnFormal.Render.render : Page → Dom";

/** The theorem statement the candidate must prove, verbatim. */
export const RENDER_THEOREM = "theorem render_ok : ∀ p : Page, Spec p (render p)";

/** Namespace Render.lean must define into (`namespace HnFormal` / `namespace Render`). */
export const RENDER_NAMESPACE = "HnFormal.Render";

/** Name checked by scripts/axiom-check.sh (`#print axioms`). */
export const RENDER_OK_QUALIFIED = "HnFormal.Render.render_ok";

export const ALLOWED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"];

/** ~24 short, divergent design briefs. Candidate n uses briefs[n % length]. */
export const BRIEFS: string[] = [
  "dense monospace terminal: one line per story, fixed-width everything, no decoration",
  "newspaper broadsheet: serif masthead, columns, hairline rules, small caps for metadata",
  "high-contrast large type: 20px+ body, black on white, generous line height, for low vision",
  "cards on a grid: each story a card, responsive grid, comments as nested cards",
  "brutalist: raw system fonts, thick borders, no rounded corners, visible structure",
  "warm paper: cream background, dark brown ink, book-like measure, subtle margins",
  "dark mode first: near-black background, soft off-white text, muted accent, dark by default",
  "swiss grid: strong typographic hierarchy, flush-left, lots of whitespace, one accent color",
  "compact dashboard: tight rows, right-aligned numbers, zebra striping, tabular feel",
  "editorial magazine: big headline for the top story, smaller stack for the rest, pull-quote style comments",
  "minimal reader: single column, no borders, hierarchy by size and weight only",
  "retro BBS: amber-on-black, box-drawing-style borders in CSS, blocky headings",
  "academic preprint: Computer Modern feel, numbered items, footnote-like metadata",
  "pastel soft UI: light pastel surfaces, rounded containers, gentle shadows, friendly",
  "high-density classic: the closest to the original HN rhythm, but cleaner and accessible",
  "timeline: stories as a vertical timeline with age markers, comments as threaded timeline nodes",
  "two-tone poster: one strong background color band for the header, bold condensed type",
  "spreadsheet: visible cell grid, column headers for rank/points/author/age/comments",
  "zen garden: lots of air, thin light type, hairline dividers, ultra restrained color",
  "mobile first: thumb-friendly tap targets, stacked metadata, designed at 375px then widened",
  "comic / zine: rough thick outlines, handwritten-feeling system fonts, playful but legible",
  "bauhaus: primary color blocks, geometric sans, strict alignment, bold numerals for rank",
  "library catalog: index-card feel, labels for every field, muted institutional palette",
  "high-contrast dark: pure black, bright white, one neon accent, for OLED and night reading",
];

export function briefFor(n: number): string {
  return BRIEFS[((n % BRIEFS.length) + BRIEFS.length) % BRIEFS.length]!;
}

const LIB_DIR = "HnFormal";

async function readLeanLibrary(): Promise<{ library: string; renderExample: string; found: string[] }> {
  const dir = fromRepo(LIB_DIR);
  const found: string[] = [];
  let library = "";
  let renderExample = "";
  if (exists(dir)) {
    const names = (await fsp.readdir(dir)).filter((f) => f.endsWith(".lean")).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const src = await fsp.readFile(full, "utf8");
      found.push(name);
      if (name === "Render.lean") {
        renderExample = src;
      } else {
        library += `\n\n<file path="${LIB_DIR}/${name}">\n${src}\n</file>`;
      }
    }
  }
  if (!library) {
    log(`warning: no Lean library sources found under ${dir}; using a placeholder in the prompt`);
    library = `\n\n<file path="HnFormal/Spec.lean">\n-- PLACEHOLDER: the Lean library (Spec.lean, Dom.lean, Item.lean, ...) was not present when this prompt was built.\n-- TODO(lead): the orchestrator includes HnFormal/*.lean here automatically once they exist.\n</file>`;
  }
  if (!renderExample) {
    renderExample = `-- PLACEHOLDER: ${EDITABLE_FILES.renderLean} did not exist when this prompt was built.\n-- Write it from scratch following the library above.`;
  }
  return { library, renderExample, found };
}

async function readCurrentCss(): Promise<string> {
  const p = fromRepo(EDITABLE_FILES.styleCss);
  if (!exists(p)) return "/* no current style.css */";
  return fsp.readFile(p, "utf8");
}

const INSTRUCTIONS = `You are the design-and-proof engine of "HN, formally" (hn-formal): an unofficial, read-only rendering of the Hacker News front page and its 30 discussion threads, produced by a renderer that is proven in Lean 4 to render every possible HN API input correctly. You redesign the site autonomously. Nobody reviews your work before it ships; the Lean kernel and a browser test suite do.

## What you produce

A JSON object with exactly three string fields:
- "renderLean": the complete new contents of ${EDITABLE_FILES.renderLean}
- "styleCss": the complete new contents of ${EDITABLE_FILES.styleCss}
- "designNotes": a short note on the design intent and proof strategy (for your own next repair round)

Both files are written verbatim. Output the whole file every time, never a diff or a fragment.

## Hard requirements for Render.lean (tier 1, checked by the Lean kernel)

- It must define \`${RENDER_SIGNATURE}\` inside namespace \`${RENDER_NAMESPACE}\`.
- It must prove \`${RENDER_THEOREM}\` (qualified name \`${RENDER_OK_QUALIFIED}\`).
- No \`sorry\`. No \`native_decide\`. No new \`axiom\` declarations. \`#print axioms ${RENDER_OK_QUALIFIED}\` must be a subset of {${ALLOWED_AXIOMS.join(", ")}}.
- Only this file may change. You cannot edit Spec.lean or any other library file; design within the Dom constructors and helper lemmas the library gives you. If the spec makes something impossible, do the simplest thing that satisfies the spec.
- The library sources below are the ground truth for names and types. Do not invent lemmas; if you need a fact, prove it locally in Render.lean.
- \`lake build\` must succeed with no errors, \`hnformal selftest\` must pass, and the rendered HTML must be valid HTML5.

## Hard requirements for style.css (tier 2, checked in a browser)

- No \`content:\` with text (empty \`content: ""\` is allowed). No \`url(\` except under \`/hn-formal/fonts/\` (self-hosted fonts only; none exist yet, so in practice no \`url(\` at all). No \`@import\`. No external origins of any kind.
- Every text node must have contrast >= 4.5:1 against its effective background (3:1 for text >= 24px, or bold >= 18.66px). Avoid text over gradients or images: the checker cannot compute contrast there and fails it.
- At a 375px viewport the page must not scroll horizontally (document.scrollWidth <= 375). Long words, URLs and code must wrap or be clipped with overflow-wrap / overflow-x on the element.
- vnu (the W3C validator) must report zero errors; axe-core must report zero serious/critical violations.
- No JavaScript at all. The site ships with CSP script-src 'none'.

## What is fixed and what is free

Fixed: the data (30 items in API order, title/url/domain/points/author/age/comments link, the "More" link, the full comment tree with nesting preserved), the link targets, the landmark/heading/link-name structure required by Spec.lean, and the nav/footer strings allowlisted there. Every text node must be a substring of the API data or one of those allowlisted strings; you cannot add copy, labels, icons via text, or emoji.

Free: everything else. Layout, typography, color, spacing, ordering of metadata within an item, whether it looks like a list at all. Interactive affordances (vote, reply, login, collapse) are plain links to news.ycombinator.com. Be bold in the design brief's direction, but accessibility and the proof come first.

## How the spec is stated (read Spec.lean; this is the summary)

- Markers: each story's container element carries \`data-hn-story="<id>"\`; each comment's container carries \`data-hn-comment="<id>"\` and the kids' containers are nested inside it. Data-bearing elements inside a container carry \`data-hn="title|comments|score|by|age|domain|descendants|text"\`. \`Spec.StoryOk\` / \`Spec.CommentOk\` state exact equalities on those fields (see \`fieldText\`, \`fieldLink\`, \`fieldBy\`, \`fieldBody\`); everything not mentioned there is free.
- The title field is an \`a\` with href \`titleHref s\` and text exactly \`displayTitle s\`; the by field is an \`a\` with href \`userHref u\` and text \`displayUser u\`; score/descendants/age/domain fields have text \`toString n\`, \`ageString now t\`, \`domainOf u\` respectively; the comments field is an \`a\` to \`itemHref s.id\` (absent for jobs, see \`commentsExpected\`); the text field's children are exactly \`Sanitize.body txt\` (story) or \`commentBody c\` (comment).
- Content gate: every text node, after trimming, must be whitespace, a string in \`Spec.fixedText\`, or a value in \`Spec.derivedText\` for an item on the page. NEVER concatenate strings in a text node: write \`[.text (displayTitle s), .text " | ", .text "HN, formally"]\` as adjacent text nodes (same bytes, each node checkable).
- About sentence: every page carries an element with \`data-hn="about"\` whose only text node is exactly \`Spec.aboutText\` (placement and styling are free; keep it as one text node).
- Links: every \`a\` href must be in \`Spec.fixedHrefs\` or \`Spec.itemHrefs i\` for an item on the page; every \`a\` must have non-blank text (or aria-label). Only tags in \`Spec.allowedTags\`; attribute names per \`attrNameOk\` (no \`style\`, no \`on*\`); the one stylesheet link; the CSP meta with \`cspContent\`; \`html[lang=en]\`; a \`main\`; a non-empty \`title\`.

## The worked example is the proof pattern, not the design

The current Render.lean below shows how a renderer is proved. It does not show what a renderer should look like. The brief decides the DOM: if the brief calls for cards, a table, a timeline, a masthead, or metadata in a different order, change the DOM to match and re-prove it with the recipe below. A candidate that keeps the DOM byte-identical and only restyles is accepted but weak; it is the fallback when a structural attempt cannot be proved, not the plan. Keep the markers and field attributes the spec requires; everything else about the tree is yours to change.

## Proof recipe (this is how the worked example does it; copy the shape of the proof, not the design)

- Start Render.lean with \`set_option maxHeartbeats 2000000\` and \`set_option maxRecDepth 4096\` (the proofs are big case splits; these lines are required).
- All-nodes properties (allowed tags, link targets, anchor names, text gate) are proved per block with the library tactic \`hn_auto\` after \`unfold\`-ing the block and doing \`cases h : s.field\` on every optional field it uses (score, author, time, descendants, url, text) and \`rcases Decidable.em (s.type = .job) with hj | hj <;> simp only [hj, ite_true, ite_false]\` where the block branches on jobs. \`hn_auto\` needs a hypothesis \`hi : s ∈ p.items\` in context. Blocks are assembled with \`have\` + \`hn_auto\` (it closes sub-goals by \`assumption\`), lists of stories with \`all_nodesList_map\`, and the page-level facts come from \`all_commonP\`.
- Fidelity (\`StoryOk\`, \`CommentOk\`) is proved by \`unfold\` + the same case splits + \`simp [findOwn, ownNodes, ownNodesList, isMarker, hasAttr, List.lookup, textContent, texts, textsList, concat, titleHref, byExpected, *]\`. Keep each marker's own fields outside nested markers; \`findOwn\` does not look inside nested markers.
- Comments: define \`wrap now c kids : Dom\` and the mutual pair \`renderComment\`/\`renderComments\` exactly as the example, then use \`CTree.nodes_all_of_wrap\`, \`CTree.treesOk_of_wrap\`, \`storyMarkersList_eq_nil\` with \`WrapShape\`; those lemmas do the induction. Sanitized bodies have lemmas \`body_commonP\`, \`sbody_findOwn\`, \`sbody_commentTree\`, \`sbody_storyMarkers\`; never unfold \`Sanitize.body\`.
- Literal goals close with \`hn_decide\` (kernel \`decide\`; refuses goals with free variables), never \`native_decide\`.
- When a repair round reports a Lean error, fix exactly that goal first: usually a missing case split, a text node that is not allowlisted (check \`fixedText\`), a concatenated string, an href not in \`fixedHrefs\`/\`itemHrefs\`, or a field placed inside a nested marker.
- Put nothing in the files that depends on the current date, run id, or random values. Keep Render.lean compact; comments in the file are fine but short.`;

/**
 * The stable prefix: identical bytes for every candidate and every round of a
 * run (so it is one cache entry shared across the 16-job matrix). The brief
 * is a separate, uncached system block.
 */
export async function buildSystemPrefix(): Promise<{ system: SystemBlocks; found: string[] }> {
  const { library, renderExample, found } = await readLeanLibrary();
  const css = await readCurrentCss();
  const text =
    INSTRUCTIONS +
    `\n\n## Lean library (read-only)\n${library}` +
    `\n\n## Worked example: the current ${EDITABLE_FILES.renderLean} (a renderer that passes)\n\n<file path="${EDITABLE_FILES.renderLean}">\n${renderExample}\n</file>` +
    `\n\n## The current ${EDITABLE_FILES.styleCss}\n\n<file path="${EDITABLE_FILES.styleCss}">\n${css}\n</file>`;
  return {
    system: [{ type: "text", text, cache_control: { type: "ephemeral", ttl: CACHE_TTL } }],
    found,
  };
}

export function briefBlock(brief: string): Anthropic.TextBlockParam {
  return { type: "text", text: `## Design brief for this candidate\n\n${brief}` };
}

export interface RoundContext {
  round: number; // 1-based
  maxRounds: number;
  previous?: { renderLean: string; styleCss: string; designNotes: string };
  failure?: { stage: string; output: string };
}

/**
 * Fresh conversation per round (never multi-turn): the previous files and
 * the failing stage's output go in a single user message. Keeps every request
 * under the 100K price cliff and avoids the preserved-thinking history check.
 */
export function roundMessages(ctx: RoundContext): Anthropic.MessageParam[] {
  if (ctx.round === 1 || !ctx.previous) {
    // No files yet (first round, or every earlier round failed before
    // producing files). Never resend a byte-identical prompt: include the
    // failure so a refusal / max_tokens / parse failure gets a different ask.
    let extra = "";
    if (ctx.failure) {
      extra =
        `\n\nYour previous attempt (round ${ctx.round - 1}) failed before producing usable files: ${tail(ctx.failure.output, 2000)}\n` +
        (ctx.failure.output.includes("max_tokens")
          ? "Keep Render.lean compact: reuse the library's helpers, avoid long comments and repeated blocks, and keep style.css under ~300 lines. "
          : "") +
        "Respond with valid JSON only: the three string fields, nothing else.";
    }
    return [
      {
        role: "user",
        content:
          `Round ${ctx.round} of ${ctx.maxRounds}. Produce a complete new Render.lean and style.css following the design brief. ` +
          `Respond with the JSON object only.` +
          extra,
      },
    ];
  }
  const f = ctx.failure ?? { stage: "unknown", output: "" };
  return [
    {
      role: "user",
      content:
        `Round ${ctx.round} of ${ctx.maxRounds}: repair. Your previous attempt failed at stage "${f.stage}".\n\n` +
        `Your previous design notes:\n${ctx.previous.designNotes}\n\n` +
        `<file path="${EDITABLE_FILES.renderLean}">\n${ctx.previous.renderLean}\n</file>\n\n` +
        `<file path="${EDITABLE_FILES.styleCss}">\n${ctx.previous.styleCss}\n</file>\n\n` +
        `Output of the failing stage (${f.stage}; tail shown if long):\n<output>\n${tail(f.output)}\n</output>\n\n` +
        `Fix the reported problem, keep the design, and respond with the full corrected files as the JSON object only.`,
    },
  ];
}

export const JUDGE_RUBRIC = `You are judging screenshots of candidate redesigns of "HN, formally", a read-only Hacker News front page and thread renderer. All candidates already passed a validity, accessibility, contrast and reflow test suite; you rank them on design quality alone. Your score never blocks a release; it only picks the best among passers.

Score 0-100 on these, equally weighted:
- Readability: comfortable type size and measure, enough line height, clear text.
- Hierarchy: the eye finds titles, then metadata, then comments; depth of comment nesting is visible.
- Scannability: 30 stories can be skimmed quickly; numbers and metadata align; nothing competes with titles.
- Taste: coherent palette and spacing, intentional, not generic; works at 1280px and at 375px.

Penalize: cramped or overflowing layouts at 375px, walls of undifferentiated text, huge empty areas, gaudy color, broken alignment, metadata louder than titles.
Reward: restraint, consistency, a distinct point of view that still reads as a news page.

Be calibrated: 50 is competent-but-plain, 70 is good, 85+ is excellent and rare. Give concrete notes.`;
