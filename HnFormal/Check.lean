import HnFormal.Spec
/-!
# Executable spec check (sanity only)

A `Bool` mirror of `Spec` used by `hnformal check` and `hnformal selftest`.
The theorem `Render.render_ok` is the guarantee; this exists to catch
problems in the *trusted* parts (JSON decoding, tree building) at run
time, and to validate fixtures.
-/
namespace HnFormal
namespace Check
open Dom Spec

mutual
def domBeq : Dom → Dom → Bool
  | .text a, .text b => a == b
  | .el t a cs, .el t' a' cs' => t == t' && a == a' && domBeqList cs cs'
  | _, _ => false
def domBeqList : List Dom → List Dom → Bool
  | [], [] => true
  | x :: xs, y :: ys => domBeq x y && domBeqList xs ys
  | _, _ => false
end

def bodiesBeq : List (List Dom) → List (List Dom) → Bool
  | [], [] => true
  | x :: xs, y :: ys => domBeqList x y && bodiesBeq xs ys
  | _, _ => false

def structure_ (d : Dom) : List (String × Bool) :=
  [("html-root", d.tag == some "html"),
   ("lang-en", d.attr "lang" == some "en"),
   ("has-main", d.nodes.any (isEl "main")),
   ("has-title", d.nodes.any fun n => n.isEl "title" && decide (0 < n.textContent.length)),
   ("csp-meta", d.nodes.any isCspMeta),
   ("about-sentence", d.nodes.any isAbout),
   ("allowed-nodes", d.nodes.all nodeOk),
   ("anchors-named", (d.byTag "a").all anchorNamed),
   ("stylesheet-only", (d.byTag "link").all linkTagOk)]

def common (p : Page) (d : Dom) : List (String × Bool) :=
  structure_ d ++
  [("links-ok", (d.byTag "a").all (linkOk p)),
   ("text-gate", d.texts.all (textOk p))]

def storyOk (withBody : Bool) (now : Nat) (s : Item) (m : Dom) : List (String × Bool) :=
  [("story-marker", m.attr "data-hn-story" == some (toString s.id)),
   ("title", ((m.findOwn "data-hn" "title").map fun a => (a.tag, a.attr "href", a.textContent))
      == [(some "a", some (titleHref s), displayTitle s)]),
   ("comments-link", fieldLink "comments" m == commentsExpected s),
   ("score", fieldText "score" m == s.score.toList.map toString),
   ("by", fieldBy m == byExpected s),
   ("age", fieldText "age" m == s.time.toList.map (ageString now)),
   ("domain", fieldText "domain" m == s.url.toList.map domainOf),
   ("descendants", fieldText "descendants" m == s.descendants.toList.map toString),
   ("body", if withBody then bodiesBeq (fieldBody m) (s.text.toList.map Sanitize.body)
            else (fieldBody m).all fun b => domBeqList b (itemBody s))]

def storiesOk (withBody : Bool) (now : Nat) : List Item → List Dom → List (String × Bool)
  | [], [] => []
  | s :: ss, m :: ms => storyOk withBody now s m ++ storiesOk withBody now ss ms
  | _, _ => [("story-count", false)]

def commentOk (now : Nat) (c : Item) (m : Dom) : List (String × Bool) :=
  [("comment-marker", m.attr "data-hn-comment" == some (toString c.id)),
   ("comment-body", bodiesBeq (fieldBody m) [commentBody c]),
   ("comment-by", fieldBy m == byExpected c),
   ("comment-age", fieldText "age" m == c.time.toList.map (ageString now))]

mutual
def treeOk (now : Nat) : CTree → CView → List (String × Bool)
  | .node c ks, .node m vs => commentOk now c m ++ treesOk now ks vs
def treesOk (now : Nat) : List CTree → List CView → List (String × Bool)
  | [], [] => []
  | k :: ks, v :: vs => treeOk now k v ++ treesOk now ks vs
  | _, _ => [("comment-shape", false)]
end

/-- All named checks for a page; the first `false` is the violated predicate. -/
def checks (p : Page) (d : Dom) : List (String × Bool) :=
  match p with
  | .front f => common p d ++ storiesOk false f.fetchedAt f.stories d.storyMarkers
  | .thread t => common p d ++ storiesOk true t.fetchedAt [t.story] d.storyMarkers ++
                 treesOk t.fetchedAt t.comments d.commentTree

def firstFailure (p : Page) (d : Dom) : Option String :=
  ((checks p d).find? fun c => !c.2).map (·.1)

end Check
end HnFormal
