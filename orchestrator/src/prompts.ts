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

/**
 * Design briefs. Each is a paragraph of direction plus one REQUIRED structural
 * move that the orchestrator verifies in the rendered HTML (CONTRACT step 8):
 * a candidate that restyles the default list shape cannot satisfy any of them.
 * Checks receive the `main` element's HTML of the front page and of the item
 * page with the most comments; they return null when satisfied.
 */
export interface Brief {
  key: string;
  title: string;
  text: string;
  /** Human-readable statement of the required move (goes in the prompt). */
  move: string;
  check: (indexMain: string, itemMain: string) => string | null;
}

const tagCount = (html: string, tag: string): number => (html.match(new RegExp(`<${tag}(?=[\\s>])`, "g")) ?? []).length;
const markedCount = (html: string, tag: string, marker: string): number =>
  (html.match(new RegExp(`<${tag}[^>]*\\s${marker}=`, "g")) ?? []).length;
const storyCount = (html: string): number => (html.match(/\sdata-hn-story=/g) ?? []).length;
const commentCount = (html: string): number => (html.match(/\sdata-hn-comment=/g) ?? []).length;

/** The story marker sits on a <tag>. */
function storiesAre(tag: string): Brief["check"] {
  return (idx) => {
    const n = storyCount(idx);
    const c = markedCount(idx, tag, "data-hn-story");
    return c >= Math.max(1, n) ? null : `expected every story container (data-hn-story) to be a <${tag}>; found ${c} of ${n} on the front page`;
  };
}
/** At least one <tag> per story on the front page. */
function perStory(tag: string, what: string): Brief["check"] {
  return (idx) => {
    const n = Math.max(1, storyCount(idx));
    const c = tagCount(idx, tag);
    return c >= n ? null : `expected ${what}: at least ${n} <${tag}> elements inside <main> on the front page, found ${c}`;
  };
}
function atLeast(tag: string, min: number, what: string): Brief["check"] {
  return (idx) => {
    const c = tagCount(idx, tag);
    return c >= min ? null : `expected ${what}: at least ${min} <${tag}> inside <main> on the front page, found ${c}`;
  };
}
const noLists: Brief["check"] = (idx) => {
  const c = tagCount(idx, "ol") + tagCount(idx, "ul");
  return c === 0 ? null : `expected no <ol> or <ul> inside <main> on the front page (stories are not a list in this brief), found ${c}`;
};
/** Comment containers on the thread page are <tag>. */
function commentsAre(tag: string): Brief["check"] {
  return (_idx, item) => {
    const n = commentCount(item);
    if (n === 0) return null;
    const c = markedCount(item, tag, "data-hn-comment");
    return c >= n ? null : `expected every comment container (data-hn-comment) on the thread page to be a <${tag}>; found ${c} of ${n}`;
  };
}
function all(...checks: Brief["check"][]): Brief["check"] {
  return (idx, item) => {
    for (const c of checks) {
      const r = c(idx, item);
      if (r) return r;
    }
    return null;
  };
}

export const BRIEFS: Brief[] = [
  {
    key: "spreadsheet",
    title: "spreadsheet",
    text: "A data grid, not a news page. Every story is a row; rank, title, domain, points, author, age and comments are columns with visible headers and a thin cell grid. Monospace or tabular figures, right-aligned numbers, a frozen header row feel. Color is functional only: one highlight for the lead row at most.",
    move: "stories are <tr> rows of a <table> with <th> column headers",
    check: all(storiesAre("tr"), atLeast("th", 3, "column headers")),
  },
  {
    key: "dashboard",
    title: "compact dashboard",
    text: "An operations console: tight rows, zebra striping, numbers right-aligned in fixed columns, title cells that truncate rather than wrap, a dense 13px-14px scale with generous horizontal rules. Think a trading terminal that happens to show links.",
    move: "stories are <tr> rows of a <table> (headers optional)",
    check: storiesAre("tr"),
  },
  {
    key: "cards",
    title: "cards on a grid",
    text: "Every story is a card: a bordered or shadowed box with the title as a heading, the domain as a small tag, and metadata along the bottom edge. Cards sit in a responsive grid (3-4 across at 1280px, 1 at 375px). Comments are nested cards with a visible indent.",
    move: "stories are <article> elements, each with an <h2> or <h3> title",
    check: all(storiesAre("article"), (idx) => (tagCount(idx, "h2") + tagCount(idx, "h3") >= Math.max(1, storyCount(idx)) ? null : "expected a heading (<h2> or <h3>) per story card")),
  },
  {
    key: "magazine",
    title: "editorial magazine",
    text: "A front page with a lead: the first story is a big headline in its own section with its metadata as a deck line; the next few are a secondary tier; the rest run as a compact stack in a narrower column. Serif display type, generous margins, a single accent. Comments read like pull quotes with the author as a byline.",
    move: "the front page is split into at least 3 <section> groups (lead, secondary, the rest); comments on the thread page are <blockquote> elements",
    check: all(atLeast("section", 3, "story groups"), commentsAre("blockquote")),
  },
  {
    key: "catalog",
    title: "library catalog",
    text: "Index cards from a card catalog: each story is a card with labelled fields, every label visible (domain, points, by, age, comments) in a small uppercase sans, values in a typewriter face. Muted institutional palette: manila, ink, one rubber-stamp red.",
    move: "each story's metadata is a <dl> definition list (dt/dd pairs)",
    check: perStory("dl", "a definition list per story"),
  },
  {
    key: "preprint",
    title: "academic preprint",
    text: "A paper in Computer Modern spirit: numbered items in a single measure, titles in roman, metadata set as footnote-sized small text under each title, hairlines between sections, no color beyond black and one link blue. The thread page reads like a numbered appendix.",
    move: "metadata per story is wrapped in <small>",
    check: perStory("small", "footnote-sized metadata"),
  },
  {
    key: "swiss",
    title: "swiss grid",
    text: "Strict modernist grid: flush-left, strong size contrast between a bold grotesque title and a light metadata line, columns aligned to a visible baseline, lots of white, one primary accent used on exactly one element per story. No boxes, no rules; alignment does the work.",
    move: "every story title is an <h2> or <h3>",
    check: (idx) => (tagCount(idx, "h2") + tagCount(idx, "h3") >= Math.max(1, storyCount(idx)) ? null : "expected a heading (<h2> or <h3>) per story"),
  },
  {
    key: "reader",
    title: "minimal reader",
    text: "A long-form reading view: no list at all. Each story is a short block of prose-like lines in a single comfortable measure, hierarchy by size and weight only, no borders, no rules, no numbers in a gutter. Quiet, warm neutrals.",
    move: "no <ol> or <ul> inside main; each story is a <section> or <article>",
    check: all(noLists, (idx) => (markedCount(idx, "section", "data-hn-story") + markedCount(idx, "article", "data-hn-story") >= Math.max(1, storyCount(idx)) ? null : "expected each story to be a <section> or <article>")),
  },
  {
    key: "zen",
    title: "zen garden",
    text: "Air and hairlines: thin light type, very wide margins, a horizontal rule between every story, metadata reduced to a whisper, one small accent. Reads slowly on purpose; at 375px the rules and margins still breathe.",
    move: "a real <hr> between stories (at least 10 inside main)",
    check: atLeast("hr", 10, "rules between stories"),
  },
  {
    key: "timeline",
    title: "timeline",
    text: "A vertical timeline: a spine down the page, each story a node with its age as the timestamp on the spine and the title branching off it. Comments on the thread page are nodes on a nested spine. The age is the most prominent metadata.",
    move: "each story's age is a <time> element",
    check: perStory("time", "a <time> element per story"),
  },
  {
    key: "terminal",
    title: "dense monospace terminal",
    text: "A terminal session: fixed-width everything, one story per line at 1280px (title, then fields in fixed columns), prompt-like markers via CSS, no decoration beyond color. Dark or light, but one monospace face throughout.",
    move: "every story's metadata fields are inside <code> elements",
    check: perStory("code", "monospace metadata in <code>"),
  },
  {
    key: "bbs",
    title: "retro BBS",
    text: "Amber or green on near-black, box-drawing-style borders done in CSS, blocky headings, a menu bar look for the nav, a status-line footer. Metadata rendered like keyboard hints.",
    move: "metadata values are wrapped in <kbd>",
    check: perStory("kbd", "metadata in <kbd>"),
  },
  {
    key: "brutalist",
    title: "brutalist",
    text: "Raw system fonts, thick black borders, no rounded corners, visible structure: each story is a heavy bordered block, numbers huge, metadata in plain black on white. Ugly on purpose, legible in fact.",
    move: "each story is an <article> and there is an <hr> after at least 10 of them",
    check: all(storiesAre("article"), atLeast("hr", 10, "rules between blocks")),
  },
  {
    key: "largetype",
    title: "high-contrast large type",
    text: "For low vision: 20px+ body, 28px+ titles, black on white, generous line height, metadata as full sentences in a paragraph under each title rather than a pipe-separated line. Links underlined, thick focus rings.",
    move: "each story's metadata is a <p> paragraph and each title an <h2>",
    check: all(perStory("p", "a metadata paragraph per story"), perStory("h2", "an <h2> per story")),
  },
  {
    key: "paper",
    title: "warm paper",
    text: "A printed broadside: cream paper, dark brown ink, book measure, titles in a text serif, metadata in small caps as a running line under each title, no list numbering in the gutter. Stories are prose entries, not list items.",
    move: "no <ol> or <ul> inside main; each story is an <article>",
    check: all(noLists, storiesAre("article")),
  },
  {
    key: "dark",
    title: "dark mode first",
    text: "Near-black background, soft off-white text, one muted accent, dark by default and not a recolor of a light page: metadata sits in a side rail next to each title, titles carry the weight. Thread page uses the rail for author and age.",
    move: "each story's metadata is an <aside> next to the title",
    check: perStory("aside", "a metadata rail per story"),
  },
  {
    key: "pastel",
    title: "pastel soft UI",
    text: "Friendly app surface: rounded containers, gentle shadows, pastel surfaces with dark text for contrast, pill-shaped tags for the domain and comment count, round avatars' worth of spacing. Each story is a soft card.",
    move: "each story is an <article>; the domain and comment count are inside <small> tags",
    check: all(storiesAre("article"), perStory("small", "pill tags in <small>")),
  },
  {
    key: "classic",
    title: "high-density classic",
    text: "The original HN rhythm, done properly: a two-line story row in a table, tiny metadata, maximum density, but with real contrast, real tap targets at 375px and no orange header.",
    move: "stories are <tr> rows of a <table>",
    check: storiesAre("tr"),
  },
  {
    key: "mobile",
    title: "mobile first",
    text: "Designed at 375px then widened: thumb-sized tap targets, stacked metadata as separate lines, titles first, big comment-count buttons, nothing side by side until 700px. Each story is a section with its metadata stacked.",
    move: "each story is a <section>",
    check: storiesAre("section"),
  },
  {
    key: "poster",
    title: "two-tone poster",
    text: "One strong color band for the header, bold condensed type, numbers as display elements: points and comment counts set huge and bold next to a smaller title. Two colors plus black.",
    move: "points and comment counts are wrapped in <strong>; each title is an <h2> or <h3>",
    check: all(perStory("strong", "bold display numbers"), (idx) => (tagCount(idx, "h2") + tagCount(idx, "h3") >= Math.max(1, storyCount(idx)) ? null : "expected a heading per story")),
  },
];

/** Day offset so the same slot does not get the same brief every run (slot 1 won three ties in a row as "broadsheet"). */
export function briefOffset(runId: string): number {
  const m = runId.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return 0;
  const days = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
  return ((days % BRIEFS.length) + BRIEFS.length) % BRIEFS.length;
}

export function briefFor(n: number, runId = ""): Brief {
  const i = (((n + briefOffset(runId)) % BRIEFS.length) + BRIEFS.length) % BRIEFS.length;
  return BRIEFS[i]!;
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
        renderExample = src; // fallback only; the fixed example below wins when present
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

/**
 * The worked example is FIXED (orchestrator/examples/*.v0.*): the plain
 * human-written renderer, not the last release. Showing the last winner
 * anchored every run on it (three broadsheet releases in a row). CI proves
 * the example still builds against the library.
 */
const EXAMPLE_DIR = "orchestrator/examples";
async function readFixedExample(): Promise<{ lean: string | null; css: string | null }> {
  const lean = fromRepo(EXAMPLE_DIR, "Render.v0.lean");
  const css = fromRepo(EXAMPLE_DIR, "style.v0.css");
  return {
    lean: exists(lean) ? await fsp.readFile(lean, "utf8") : null,
    css: exists(css) ? await fsp.readFile(css, "utf8") : null,
  };
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
- Links inside running text (comment bodies and story text under \`[data-hn="text"]\`, and any \`a\` inside a \`p\`) must be distinguishable without color: keep \`text-decoration: underline\` on them. axe rule link-in-text-block fails otherwise; removing those underlines cost several candidates a repair round.
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

The Render.lean below is a deliberately plain human-written renderer. It shows how a renderer is proved; it is not what the live site looks like and not what you should produce. The brief decides the DOM: it names a required structural move (a table, cards, a definition list, headings, a timeline, no list at all) and the orchestrator verifies that move in the rendered HTML. Build the tree the brief asks for and re-prove it with the recipe below. The proof for a different tree is the same work: the same block lemmas, the same case splits, one \`hn_auto\` per block; only the constructors between the markers change.

How a release is chosen: among candidates that pass the kernel and the browser suite, a judge scores adherence to the brief (40%), novelty against the current live site (30%) and craft (30%). A restyle of the plain list shape scores near zero on the first two. Be bold in the brief's direction; keep the markers and field attributes the spec requires; everything else about the tree is yours. The orchestrator checks this: after a candidate passes both tiers it renders the current site and the candidate on the same data and compares the \`main\` element's HTML with class attributes removed (header, nav and footer do not count). If they are identical, the first rounds are sent back with a "structure" failure (the restyle is kept as a fallback), and a changed DOM wins ties in the final ranking.

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
  const fixed = await readFixedExample();
  const lean = fixed.lean ?? renderExample;
  const css = fixed.css ?? (await readCurrentCss());
  const text =
    INSTRUCTIONS +
    `\n\n## Lean library (read-only)\n${library}` +
    `\n\n## Worked example: a plain renderer that passes (the proof pattern; NOT the design to produce)\n\n<file path="${EDITABLE_FILES.renderLean}">\n${lean}\n</file>` +
    `\n\n## The stylesheet of that plain example\n\n<file path="${EDITABLE_FILES.styleCss}">\n${css}\n</file>`;
  return {
    system: [{ type: "text", text, cache_control: { type: "ephemeral", ttl: CACHE_TTL } }],
    found,
  };
}

export function briefBlock(brief: Brief, recent: string[] = []): Anthropic.TextBlockParam {
  const avoid = recent.length
    ? `\n\n## Do not repeat\n\nThe live site and the most recent releases were, newest first: ${recent.map((r) => `"${r}"`).join(", ")}. The judge scores novelty against the live site; a design that resembles it scores at most 20 of 100 on novelty whatever its brief. Make something a reader would not mistake for any of those.`
    : "";
  return {
    type: "text",
    text:
      `## Design brief for this candidate: ${brief.title}\n\n${brief.text}\n\n` +
      `Required structure (verified by the orchestrator in the rendered HTML): ${brief.move}. ` +
      `This is checked for your first rounds; a candidate without it is sent back with the reason, and the orchestrator keeps any passing version as a fallback, so you lose nothing by attempting it.` +
      avoid,
  };
}

export interface RoundContext {
  round: number; // 1-based
  maxRounds: number;
  previous?: { renderLean: string; styleCss: string; designNotes: string };
  failure?: { stage: string; output: string };
  /** base64 PNG of the current live site's front page (round 1 only): what NOT to resemble. */
  currentSitePng?: string;
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
    const ask =
      `Round ${ctx.round} of ${ctx.maxRounds}. Produce a complete new Render.lean and style.css following the design brief, including its required structure. ` +
      `Respond with the JSON object only.` +
      extra;
    if (ctx.currentSitePng) {
      return [
        {
          role: "user",
          content: [
            { type: "text", text: "This is the current live site's front page at 1280px. Novelty is scored against it: your design must not be mistaken for it." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: ctx.currentSitePng } },
            { type: "text", text: ask },
          ],
        },
      ];
    }
    return [{ role: "user", content: ask }];
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
        (f.stage === "structure" || f.stage === "brief"
          ? `Keep the visual direction but change the document structure as the output describes (the brief's required move is not optional), re-prove render_ok for the new tree, and respond with the full new files as the JSON object only.`
          : `Fix the reported problem, keep the design, and respond with the full corrected files as the JSON object only.`),
    },
  ];
}

export const JUDGE_RUBRIC = `You judge candidate redesigns of "HN, formally", a read-only Hacker News front page and thread renderer. Every candidate already passed a validity, accessibility, contrast and reflow suite; your scores pick the best among passers and never block a release.

You receive: the candidate's design brief, one screenshot of the CURRENT LIVE SITE (a reference for novelty; do not score it), and three screenshots of the candidate (front page at 1280px, front page at 375px, a thread page at 1280px).

Return three integer sub-scores, 0-100 each:
- adherence: how fully the candidate realizes the brief: its layout grammar, its required structure, its type and color direction. 90+ only if someone who had read the brief would recognize it at a glance; 40 or below if the brief is only hinted at by colors or fonts.
- novelty: how different the candidate is from the current live site in page shape and look. Same layout with new colors or fonts: at most 20. Same layout with reordered metadata or an extra wrapper: at most 35. A genuinely different page shape (table, cards, timeline, magazine lead, prose blocks, side rails): 70 or more.
- craft: readability, hierarchy (titles, then metadata, then comments; nesting depth visible), scannability of 30 stories, coherent palette and spacing, and whether it holds up at 375px. Penalize overflow, walls of undifferentiated text, huge empty areas, broken alignment, metadata louder than titles.

A safe generic news-list look is not a virtue here: reward bold, specific choices that still read. Be calibrated within each sub-score (50 competent, 70 good, 85+ rare). Give two to five sentences of concrete notes, including what the brief asked for that is missing.`;
