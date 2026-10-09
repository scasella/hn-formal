import HnFormal.Sanitize
/-!
# The specification (version 1)

Human-authored. The loop may not edit this file. `Spec p d` is what
`Render.render_ok` proves for every page `p`.

Text nodes: the content gate checks each text node separately, so a
renderer must never concatenate strings; it emits adjacent text nodes
instead (`[.text (displayTitle s), .text " | HN, formally"]`), which
serialize to the same bytes.

Deployment: `sitePrefix` is the path the site is served under. Changing it is
a spec version bump (hrefs are part of the claim) and implies a baseline
re-run.

Markers: the renderer tags each story's container with
`data-hn-story="<id>"` and each comment's container with
`data-hn-comment="<id>"`, and tags data-bearing elements inside with
`data-hn="title|comments|score|by|age|domain|descendants|text"`. Everything
else about the DOM is free, subject to the structural rules below.
-/
namespace HnFormal
namespace Spec

def version : Nat := 1

def hnBase : String := "https://news.ycombinator.com/"

/-- Root-relative path prefix the site is served under (GitHub project
Pages: `https://scasella.github.io/hn-formal/`). Empty for a root deploy. -/
def sitePrefix : String := "/hn-formal"

def homeHref : String := sitePrefix ++ "/"
def styleHref : String := sitePrefix ++ "/style.css"
def loopHref : String := sitePrefix ++ "/loop/"
def specHref : String := sitePrefix ++ "/spec/Spec.lean"

@[irreducible] def itemHref (id : Nat) : String := sitePrefix ++ "/item/" ++ toString id ++ ".html"
@[irreducible] def userHref (u : String) : String := hnBase ++ "user?id=" ++ u
@[irreducible] def hnItemHref (id : Nat) : String := hnBase ++ "item?id=" ++ toString id

/-- Story links are the API url, percent-encoded where the URL standard
requires it (see `Sanitize.encodeHref`); text-only items link to their
page. -/
@[irreducible] def titleHref (s : Item) : String :=
  match s.url with
  | some u => Sanitize.encodeHref u
  | none => itemHref s.id

@[irreducible] def plainTitle (s : Item) : String := Sanitize.plain (s.title.getD "")

/-- `s` unless it is blank, in which case `fallback`. The API can return
blank titles and authors; anchors must still have names. -/
def nonblank (fallback s : String) : String := if (trimS s).isEmpty then fallback else s

def displayTitle (s : Item) : String := nonblank "untitled" (plainTitle s)
def displayUser (u : String) : String := nonblank "anonymous" u

@[irreducible] def domainOf (u : String) : String :=
  let u := if u.startsWith "https://" then u.drop 8
           else if u.startsWith "http://" then u.drop 7 else u
  let u := if u.startsWith "www." then u.drop 4 else u
  (u.takeWhile fun c => c != '/' && c != '?' && c != '#').copy

def plural (n : Nat) (w : String) : String :=
  toString n ++ " " ++ w ++ (if n == 1 then "" else "s") ++ " ago"

/-- HN-style relative age. `now` is the page's `fetchedAt`. -/
@[irreducible] def ageString (now t : Nat) : String :=
  let d := now - t
  if d < 60 then "just now"
  else if d < 3600 then plural (d / 60) "minute"
  else if d < 86400 then plural (d / 3600) "hour"
  else plural (d / 86400) "day"

def cspContent : String :=
  "default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"

/-- Elements the renderer may emit. No script, style, img, svg, iframe,
form, details, or anything that executes, loads, or hides content. -/
def allowedTags : List String :=
  ["html", "head", "meta", "title", "link", "body", "header", "nav", "main",
   "footer", "section", "article", "aside", "div", "span", "p", "a", "ol",
   "ul", "li", "h1", "h2", "h3", "h4", "h5", "h6", "time", "small", "strong",
   "em", "b", "i", "code", "pre", "br", "hr", "table", "thead", "tbody", "tr",
   "th", "td", "blockquote", "abbr", "address", "dl", "dt", "dd", "sup",
   "sub", "mark", "kbd", "cite", "q", "s", "u"]

/-- Text the renderer may emit that is not API data (compared after trim). -/
def fixedText : List String :=
  ["HN, formally", "Hacker News", "hn-formal", "front page", "new", "past",
   "comments", "comment", "ask", "show", "jobs", "submit", "login", "More",
   "more", "points", "point", "pts", "by", "ago", "|", "·", "•", "—", "–", "-",
   "(", ")", "[", "]", ".", ",", ":", ";", "#", "↑", "▲", "△", "*", "/", "\\",
   "discuss", "hide", "reply", "parent", "root", "prev", "next", "on", "on:",
   "[deleted]", "[dead]", "[flagged]", "deleted", "dead", "flag", "vote",
   "upvote", "share", "link", "permalink", "back", "home", "top", "item",
   "job", "story", "poll", "pollopt", "Ask HN", "Show HN", "Launch HN",
   "Unofficial. Not affiliated with Y Combinator.",
   "Unofficial", "Not affiliated with Y Combinator", "Y Combinator",
   "The original is at", "news.ycombinator.com", "view on Hacker News",
   "View on Hacker News", "Open on Hacker News", "original", "source",
   "verified", "proven", "formally verified", "Every page is proven in Lean 4",
   "loop", "the loop", "how this works", "about", "spec", "Lean 4", "Lean",
   "Discussion", "discussion", "Thread", "thread", "Comments", "Stories",
   "stories", "Front page", "Page", "page", "Rank", "rank", "Score", "score",
   "Author", "author", "Age", "age", "Domain", "domain", "Title", "title",
   "Skip to content", "Skip to main content", "Navigation", "navigation",
   "Main", "main", "Footer", "footer", "Menu", "menu", "Read", "read",
   "Open", "open", "Visit", "visit", "Go", "go", "→", "←", "↗", "»", "«",
   "›", "‹", "…", "...", "~", "+", "=", "?", "!", "@", "&", "%", "$",
   "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "0", "00", "30",
   "updated", "Updated", "fetched", "Fetched", "as of", "As of",
   "This page is static. Interactions open the original site.",
   "Interactions open the original site", "static", "Static"]

/-! ## Structural rules -/

def startsOn (s : String) : Bool :=
  match s.toList with
  | 'o' :: 'n' :: _ => true
  | _ => false

def attrNameOk (k : String) : Bool :=
  Dom.nameOk k && !startsOn k && k != "style" && k != "srcdoc"

/-- Attribute rules depend only on the name; values are free (hrefs are
checked separately by `linkOk`). -/
def attrOk (p : String × String) : Bool := attrNameOk p.1

def nodeOk : Dom → Bool
  | .text _ => true
  | .el t a _ => allowedTags.contains t && a.all attrOk

def linkTagOk (l : Dom) : Bool :=
  l.attr "rel" == some "stylesheet" && l.attr "href" == some styleHref

def anchorNamed (a : Dom) : Bool :=
  !(trimS a.textContent).isEmpty || (a.attr "aria-label").isSome

def isCspMeta (m : Dom) : Bool :=
  m.attr "http-equiv" == some "Content-Security-Policy" && m.attr "content" == some cspContent

/-- Page-level structure: an `html[lang]` root, a `main`, a non-empty
`title`, the CSP meta, every anchor named, only allowed elements and
attributes, only the one stylesheet. -/
def Structure (d : Dom) : Prop :=
  d.tag = some "html" ∧
  d.attr "lang" = some "en" ∧
  (d.nodes.any (Dom.isEl "main")) = true ∧
  (d.nodes.any fun n => n.isEl "title" && decide (0 < n.textContent.length)) = true ∧
  (d.nodes.any isCspMeta) = true ∧
  (d.nodes.all nodeOk) = true ∧
  ((d.byTag "a").all anchorNamed) = true ∧
  ((d.byTag "link").all linkTagOk) = true

/-! ## Links and text -/

def itemBody (i : Item) : List Dom := Sanitize.body (i.text.getD "")

/-- Hrefs the renderer may emit that are not tied to an item. -/
def fixedHrefs : List String :=
  [homeHref, sitePrefix ++ "/index.html", "#main", "#top", "#content", "#stories", "#comments",
   loopHref, sitePrefix ++ "/loop/index.html", specHref,
   "https://github.com/scasella/hn-formal",
   hnBase, hnBase ++ "news", hnBase ++ "newest", hnBase ++ "front",
   hnBase ++ "newcomments", hnBase ++ "ask", hnBase ++ "show", hnBase ++ "jobs",
   hnBase ++ "submit", hnBase ++ "login", hnBase ++ "newsfaq.html",
   hnBase ++ "newsguidelines.html", hnBase ++ "news?p=2"]

/-- Hrefs the renderer may emit for item `i`. -/
def itemHrefs (i : Item) : List String :=
  [itemHref i.id, hnItemHref i.id, "#" ++ toString i.id, "#c" ++ toString i.id,
   "#item-" ++ toString i.id, hnBase ++ "reply?id=" ++ toString i.id,
   hnBase ++ "vote?id=" ++ toString i.id ++ "&how=up",
   hnBase ++ "hide?id=" ++ toString i.id, hnBase ++ "flag?id=" ++ toString i.id] ++
  i.author.toList.map userHref ++ i.url.toList.map Sanitize.encodeHref ++ Dom.hrefsIn (itemBody i)

def hrefOk (p : Page) (h : String) : Bool :=
  fixedHrefs.contains h || p.items.any fun i => (itemHrefs i).contains h

/-- An anchor may point home, to HN, to a page of this site for an item on
this page, or to a URL that came from the API. -/
def linkOk (p : Page) (a : Dom) : Bool :=
  match a.attr "href" with
  | none => true
  | some h => hrefOk p h

def derivedText (now : Nat) (i : Item) : List String :=
  [plainTitle i, displayTitle i, toString i.id] ++ i.author.toList ++ i.author.toList.map displayUser ++
  i.score.toList.map toString ++ i.descendants.toList.map toString ++
  i.url.toList ++ i.url.toList.map domainOf ++
  i.time.toList.map (ageString now) ++ Dom.textsList (itemBody i)

/-- The content gate: every text node is whitespace, a fixed string, or a
value derived from an item on this page. -/
def textOk (p : Page) (t : String) : Bool :=
  let t := trimS t
  t.isEmpty || fixedText.any (· == t) ||
  p.items.any fun i => (derivedText p.fetchedAt i).any (trimS · == t)

/-! ## Data fidelity -/

def fieldText (name : String) (m : Dom) : List String :=
  (m.findOwn "data-hn" name).map Dom.textContent

def fieldLink (name : String) (m : Dom) : List (Option String × Option String) :=
  (m.findOwn "data-hn" name).map fun a => (a.tag, a.attr "href")

def fieldBy (m : Dom) : List (Option String × String) :=
  (m.findOwn "data-hn" "by").map fun a => (a.attr "href", a.textContent)

def byExpected (i : Item) : List (Option String × String) :=
  i.author.toList.map fun u => (some (userHref u), displayUser u)

def fieldBody (m : Dom) : List (List Dom) :=
  (m.findOwn "data-hn" "text").map Dom.children

def commentsExpected (s : Item) : List (Option String × Option String) :=
  if s.type = .job then [] else [(some "a", some (itemHref s.id))]

/-- A story marker `m` renders item `s` faithfully. `withBody` requires the
story text (Ask HN etc.) to be present; it is required on thread pages and
optional-but-exact on the front page. -/
def StoryOk (withBody : Bool) (now : Nat) (s : Item) (m : Dom) : Prop :=
  m.attr "data-hn-story" = some (toString s.id) ∧
  ((m.findOwn "data-hn" "title").map fun a => (a.tag, a.attr "href", a.textContent))
    = [(some "a", some (titleHref s), displayTitle s)] ∧
  fieldLink "comments" m = commentsExpected s ∧
  fieldText "score" m = s.score.toList.map toString ∧
  fieldBy m = byExpected s ∧
  fieldText "age" m = s.time.toList.map (ageString now) ∧
  fieldText "domain" m = s.url.toList.map domainOf ∧
  fieldText "descendants" m = s.descendants.toList.map toString ∧
  (if withBody then fieldBody m = s.text.toList.map Sanitize.body
   else ∀ b ∈ fieldBody m, b = itemBody s)

def commentBody (c : Item) : List Dom :=
  if c.deleted || c.dead then [] else itemBody c

/-- A comment marker `m` renders comment `c` faithfully. -/
def CommentOk (now : Nat) (c : Item) (m : Dom) : Prop :=
  m.attr "data-hn-comment" = some (toString c.id) ∧
  fieldBody m = [commentBody c] ∧
  fieldBy m = byExpected c ∧
  fieldText "age" m = c.time.toList.map (ageString now)

/-- Pointwise: the i-th story marker renders the i-th story. -/
def StoriesOk (withBody : Bool) (now : Nat) : List Item → List Dom → Prop
  | [], [] => True
  | s :: ss, m :: ms => StoryOk withBody now s m ∧ StoriesOk withBody now ss ms
  | _, _ => False

mutual
/-- A comment subtree is rendered faithfully by a marker view: the marker
renders the comment and its nested markers render the kids, in order. -/
def TreeOk (now : Nat) : CTree → Dom.CView → Prop
  | .node c ks, .node m vs => CommentOk now c m ∧ TreesOk now ks vs
def TreesOk (now : Nat) : List CTree → List Dom.CView → Prop
  | [], [] => True
  | k :: ks, v :: vs => TreeOk now k v ∧ TreesOk now ks vs
  | _, _ => False
end

/-! ## Pages -/

def Common (p : Page) (d : Dom) : Prop :=
  Structure d ∧
  ((d.byTag "a").all (linkOk p)) = true ∧
  (d.texts.all (textOk p)) = true

def FrontOk (f : Front) (d : Dom) : Prop :=
  Common (.front f) d ∧
  StoriesOk false f.fetchedAt f.stories d.storyMarkers

def ThreadOk (t : Thread) (d : Dom) : Prop :=
  Common (.thread t) d ∧
  StoriesOk true t.fetchedAt [t.story] d.storyMarkers ∧
  TreesOk t.fetchedAt t.comments d.commentTree

/-- THE SPEC. -/
def Spec : Page → Dom → Prop
  | .front f, d => FrontOk f d
  | .thread t, d => ThreadOk t d

end Spec
end HnFormal
