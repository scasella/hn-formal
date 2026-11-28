import HnFormal.Lemmas
/-!
# Renderer: a spreadsheet grid

Stories are rows of a table with column headers (`th`). Comments stay a nested list.
-/
set_option maxHeartbeats 2000000
set_option maxRecDepth 4096

namespace HnFormal
namespace Render
open Dom Spec

def a (href label : String) : Dom := .el "a" [("href", href)] [.text label]

def field (name txt : String) : Dom := .el "span" [("data-hn", name)] [.text txt]

def frontTitle : List String :=
  ["HN, formally", " | ", "Hacker News", " ", "front page", ". ", "Every page is proven in Lean 4"]

def pageHead (titleParts : List String) : Dom :=
  .el "head" [] [
    .el "meta" [("charset", "utf-8")] [],
    .el "meta" [("name", "viewport"), ("content", "width=device-width, initial-scale=1")] [],
    .el "meta" [("http-equiv", "Content-Security-Policy"), ("content", cspContent)] [],
    .el "meta" [("name", "description"), ("content", aboutText)] [],
    .el "meta" [("property", "og:title"), ("content", "HN, formally: the Hacker News front page, redesigned nightly by an AI and proven in Lean 4")] [],
    .el "meta" [("property", "og:description"), ("content", aboutText)] [],
    .el "meta" [("property", "og:image"), ("content", previewHref)] [],
    .el "meta" [("property", "og:image:width"), ("content", "1280")] [],
    .el "meta" [("property", "og:image:height"), ("content", "670")] [],
    .el "meta" [("property", "og:type"), ("content", "website")] [],
    .el "meta" [("name", "twitter:card"), ("content", "summary_large_image")] [],
    .el "title" [] (titleParts.map Dom.text),
    .el "link" [("rel", "stylesheet"), ("href", styleHref)] []]

def topNav : Dom :=
  .el "header" [] [
    .el "nav" [] [
      a homeHref "HN, formally", .text " | ",
      a (hnBase ++ "newest") "new", .text " | ",
      a (hnBase ++ "front") "past", .text " | ",
      a (hnBase ++ "newcomments") "comments", .text " | ",
      a (hnBase ++ "ask") "ask", .text " | ",
      a (hnBase ++ "show") "show", .text " | ",
      a (hnBase ++ "jobs") "jobs", .text " | ",
      a (hnBase ++ "submit") "submit"]]

def footer : Dom :=
  .el "footer" [] [
    .el "p" [("data-hn", "about")] [.text aboutText],
    .text "Unofficial. Not affiliated with Y Combinator. ",
    a hnBase "The original is at", .text " ", a hnBase "news.ycombinator.com", .text ". ",
    a loopHref "how this works"]

/-! ## Table pieces -/

def th (h : String) : Dom := .el "th" [("scope", "col")] [.text h]

def thead : Dom :=
  .el "thead" [] [.el "tr" [] [th "Score", th "Title", th "Domain", th "Author", th "Age", th "Comments"]]

def commentsCell (s : Item) : Dom :=
  .el "td" [("class", "num")]
    (s.descendants.toList.map (fun n => field "descendants" (toString n)) ++
      (if s.type = .job then [] else [.el "a" [("href", itemHref s.id), ("data-hn", "comments")] [.text "comments"]]))

def cells (now : Nat) (s : Item) : List Dom :=
  [.el "td" [("class", "num")] (s.score.toList.map fun n => field "score" (toString n)),
   .el "td" [("class", "title")] [.el "a" [("href", titleHref s), ("data-hn", "title")] [.text (displayTitle s)]],
   .el "td" [("class", "domain")] (s.url.toList.map fun u => field "domain" (domainOf u)),
   .el "td" [("class", "by")] (s.author.toList.map fun u => .el "a" [("href", userHref u), ("data-hn", "by")] [.text (displayUser u)]),
   .el "td" [("class", "age")] (s.time.toList.map fun t => field "age" (ageString now t)),
   commentsCell s]

def storyRow (now : Nat) (s : Item) : Dom :=
  .el "tr" [("data-hn-story", toString s.id)] (cells now s)

def bodyCells (s : Item) : List Dom :=
  s.text.toList.map fun t => .el "td" [("class", "body"), ("data-hn", "text")] (Sanitize.body t)

def storyRowT (now : Nat) (s : Item) : Dom :=
  .el "tr" [("data-hn-story", toString s.id)] (cells now s ++ bodyCells s)

/-! ## Comments -/

def wrap (now : Nat) (c : Item) (kids : List Dom) : Dom :=
  .el "li" [("data-hn-comment", toString c.id)] [
    .el "div" [("class", "chead")]
      ((c.author.toList.flatMap fun u => [.el "a" [("href", userHref u), ("data-hn", "by")] [.text (displayUser u)], .text " "]) ++
       (c.time.toList.map fun t => field "age" (ageString now t)) ++
       (if c.deleted || c.dead then [.text " [deleted]"] else [])),
    .el "div" [("data-hn", "text")] (commentBody c),
    .el "ol" [("class", "kids")] kids]

mutual
def renderComment (now : Nat) : CTree → Dom
  | .node c ks => wrap now c (renderComments now ks)
def renderComments (now : Nat) : List CTree → List Dom
  | [] => []
  | k :: ks => renderComment now k :: renderComments now ks
end

/-! ## Pages -/

def renderFront (f : Front) : Dom :=
  .el "html" [("lang", "en")] [
    pageHead frontTitle,
    .el "body" [] [
      topNav,
      .el "main" [] [
        .el "table" [("class", "grid")] [thead, .el "tbody" [] (f.stories.map (storyRow f.fetchedAt))],
        .el "div" [("class", "more")] [a (hnBase ++ "news?p=2") "More"]],
      footer]]

def renderThread (t : Thread) : Dom :=
  .el "html" [("lang", "en")] [
    pageHead [displayTitle t.story, " | ", "HN, formally"],
    .el "body" [] [
      topNav,
      .el "main" [] [
        .el "table" [("class", "grid")] [thead, .el "tbody" [] [storyRowT t.fetchedAt t.story]],
        .el "ol" [("class", "comments")] (renderComments t.fetchedAt t.comments)],
      footer]]

/-- THE RENDERER. -/
def render : Page → Dom
  | .front f => renderFront f
  | .thread t => renderThread t

/-! ## Proof: all-nodes -/

theorem topNav_ok (p : Page) : (nodes topNav).all (commonP p) = true := by
  unfold topNav a; hn_auto

theorem footer_ok (p : Page) : (nodes footer).all (commonP p) = true := by
  unfold footer a; hn_auto

theorem pageHead_ok (p : Page) (parts : List String) (ht : parts.all (textOk p) = true) :
    (nodes (pageHead parts)).all (commonP p) = true := by
  have : (nodesList (parts.map Dom.text)).all (commonP p) = true := by
    rw [nodesList_map]
    apply all_flatMap
    intro x hx
    have := List.all_eq_true.1 ht x hx
    simp [nodes, this]
  unfold pageHead; hn_auto

set_option maxHeartbeats 8000000 in
theorem cells_ok (p : Page) (now : Nat) (s : Item) (hi : s ∈ p.items) (hnow : p.fetchedAt = now) :
    (nodesList (cells now s)).all (commonP p) = true := by
  subst hnow
  unfold cells commentsCell field
  cases hu : s.url <;> cases hsc : s.score <;> cases hau : s.author <;> cases hti : s.time
    <;> cases hde : s.descendants <;> rcases Decidable.em (s.type = .job) with hj | hj
    <;> simp only [hj, ite_true, ite_false] <;> hn_auto

theorem bodyCells_ok (p : Page) (s : Item) (hi : s ∈ p.items) :
    (nodesList (bodyCells s)).all (commonP p) = true := by
  unfold bodyCells
  cases ht : s.text with
  | none => simp [nodesList]
  | some x =>
    have h3 : (nodesList (Sanitize.body x)).all (commonP p) = true := by
      simpa [itemBody, ht] using body_commonP p s hi
    hn_auto

theorem row_ok (p : Page) (now : Nat) (s : Item) (hi : s ∈ p.items) (hnow : p.fetchedAt = now) :
    (nodes (storyRow now s)).all (commonP p) = true := by
  have h := cells_ok p now s hi hnow
  unfold storyRow
  hn_auto

theorem rowT_ok (p : Page) (now : Nat) (s : Item) (hi : s ∈ p.items) (hnow : p.fetchedAt = now) :
    (nodes (storyRowT now s)).all (commonP p) = true := by
  have h := cells_ok p now s hi hnow
  have hb := bodyCells_ok p s hi
  unfold storyRowT
  hn_auto

/-! ## Proof: comment wrap -/

theorem wrap_ok (p : Page) (now : Nat) (c : Item) (ds : List Dom) (hi : c ∈ p.items) (hnow : p.fetchedAt = now)
    (hds : (nodesList ds).all (commonP p) = true) :
    (nodes (wrap now c ds)).all (commonP p) = true := by
  subst hnow
  have h3 := body_commonP p c hi
  unfold wrap field commentBody
  cases hau : c.author <;> cases hti : c.time <;> rcases Bool.eq_false_or_eq_true (c.deleted || c.dead) with hd | hd <;> simp only [hd, ite_true, ite_false, Bool.false_eq_true] <;> hn_auto

theorem wrapShape (now : Nat) : WrapShape (wrap now) (renderComment now) (renderComments now) :=
  ⟨fun _ _ => rfl, rfl, fun _ _ => rfl⟩

theorem wrap_fidelity (now : Nat) (c : Item) (ds : List Dom) (hds : ∀ d ∈ ds, isMarker d = true) :
    CommentOk now c (wrap now c ds) := by
  have hown := ownNodesList_eq_nil_of_markers ds hds
  unfold CommentOk wrap field fieldText fieldBy fieldBody commentBody
  cases hau : c.author <;> cases hti : c.time <;> rcases Bool.eq_false_or_eq_true (c.deleted || c.dead) with hd | hd <;> simp only [hd, ite_true, ite_false, Bool.false_eq_true]
  all_goals
    simp [findOwn, ownNodes, ownNodesList, isMarker, hasAttr, List.lookup,
      textContent, texts, textsList, concat, byExpected, itemBody, *]

theorem wrap_tree (now : Nat) (c : Item) (ds : List Dom) :
    commentTree (wrap now c ds) = [.node (wrap now c ds) (commentTreeList ds)] := by
  unfold wrap field commentBody
  cases hau : c.author <;> cases hti : c.time <;> rcases Bool.eq_false_or_eq_true (c.deleted || c.dead) with hd | hd <;> simp only [hd, ite_true, ite_false, Bool.false_eq_true]
  all_goals
    simp [commentTree, commentTreeList, List.lookup, itemBody, *]

theorem wrap_marker (now : Nat) (c : Item) (ds : List Dom) : isMarker (wrap now c ds) = true := by
  simp [wrap, isMarker, attr, List.lookup]

theorem wrap_noStory (now : Nat) (c : Item) (ds : List Dom)
    (h : (nodesList ds).all (fun n => (n.attr "data-hn-story").isNone) = true) :
    (nodes (wrap now c ds)).all (fun n => (n.attr "data-hn-story").isNone) = true := by
  have h3 := body_no_story c
  unfold wrap field commentBody
  cases hau : c.author <;> cases hti : c.time <;> rcases Bool.eq_false_or_eq_true (c.deleted || c.dead) with hd | hd <;> simp only [hd, ite_true, ite_false, Bool.false_eq_true]
  all_goals
    simp only [nodes, nodesList, nodesList_append, List.all_append, List.all_cons, List.all_nil,
      Bool.and_eq_true, attr_el, attr_text, List.lookup, List.nil_append, List.append_nil, Option.toList,
      List.map_nil, List.map_cons, List.flatMap_nil, List.flatMap_cons, Option.isNone_none, and_true]
    simp_all

/-! ## Proof: rows -/

theorem row_marker (now : Nat) (s : Item) : storyMarkers (storyRow now s) = [storyRow now s] := by
  simp [storyRow, storyMarkers, List.lookup]

set_option maxHeartbeats 8000000 in
theorem row_fidelity (now : Nat) (s : Item) : StoryOk false now s (storyRow now s) := by
  unfold StoryOk storyRow cells commentsCell field fieldLink fieldText fieldBy fieldBody commentsExpected
  cases hu : s.url <;> cases hsc : s.score <;> cases hau : s.author <;> cases hti : s.time
    <;> cases hde : s.descendants <;> rcases Decidable.em (s.type = .job) with hj | hj <;> simp only [hj, ite_true, ite_false]
  all_goals
    simp [findOwn, ownNodes, ownNodesList, isMarker, hasAttr, List.lookup, textContent, texts,
      textsList, concat, titleHref, byExpected, *]

set_option maxHeartbeats 8000000 in
theorem rowT_fidelity (now : Nat) (s : Item) : StoryOk true now s (storyRowT now s) := by
  unfold StoryOk storyRowT cells commentsCell bodyCells field fieldLink fieldText fieldBy fieldBody commentsExpected
  cases hu : s.url <;> cases hsc : s.score <;> cases hau : s.author <;> cases hti : s.time
    <;> cases hde : s.descendants <;> cases htx : s.text <;> rcases Decidable.em (s.type = .job) with hj | hj
    <;> simp only [hj, ite_true, ite_false]
  all_goals
    simp [findOwn, ownNodes, ownNodesList, isMarker, hasAttr, List.lookup, textContent, texts,
      textsList, concat, titleHref, byExpected, Option.toList, *]

/-! ## Pages -/

set_option maxHeartbeats 8000000 in
theorem front_ok (f : Front) : FrontOk f (renderFront f) := by
  have hrows : (nodesList (f.stories.map (storyRow f.fetchedAt))).all (commonP (.front f)) = true :=
    all_nodesList_map _ _ _ fun s hs => row_ok (.front f) f.fetchedAt s hs rfl
  have hnav := topNav_ok (.front f)
  have hfoot := footer_ok (.front f)
  have hhead : (nodes (pageHead frontTitle)).all (commonP (.front f)) = true :=
    pageHead_ok _ _ (by
      unfold frontTitle
      simp only [List.all_cons, List.all_nil, Bool.and_true, Bool.and_eq_true]
      refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> first | (apply textOk_fixed; hn_decide) | (apply textOk_empty; hn_decide))
  have hall : (nodes (renderFront f)).all (commonP (.front f)) = true := by
    unfold renderFront a thead th; hn_auto
  obtain ⟨hnodes, hlinks, hnamed, hlinkTags, htexts⟩ := all_commonP _ _ hall
  refine ⟨⟨⟨rfl, rfl, ?_, ?_, ?_, ?_, ?_, ?_, ?_, hnodes, hnamed, hlinkTags⟩, hlinks, htexts⟩, ?_⟩
  · simp [renderFront, pageHead, frontTitle, topNav, nodes, nodesList, isEl]
  · simp [renderFront, pageHead, frontTitle, nodes, nodesList, isEl, textContent, texts, textsList, concat]
    left; decide +kernel
  · simp [renderFront, pageHead, frontTitle, nodes, nodesList, isCspMeta, List.lookup]
  · simp [renderFront, pageHead, frontTitle, nodes, nodesList, isDescriptionMeta, List.lookup]
  · simp [renderFront, pageHead, frontTitle, nodes, nodesList, isPreviewMeta, List.lookup]
  · simp [renderFront, pageHead, frontTitle, nodes, nodesList, isCardMeta, List.lookup]
  · simp [renderFront, pageHead, frontTitle, topNav, footer, a, nodes, nodesList, isAbout, hasAttr, List.lookup,
      textContent, texts, textsList, concat]
  · have : storyMarkers (renderFront f) = f.stories.map (storyRow f.fetchedAt) := by
      simp [renderFront, pageHead, frontTitle, topNav, footer, a, thead, th, storyMarkers, storyMarkersList,
        List.lookup, storyMarkersList_map, row_marker, flatMap_singleton_eq_map]
    rw [this]
    exact storiesOk_map _ _ _ _ fun s _ => row_fidelity f.fetchedAt s

set_option maxHeartbeats 8000000 in
theorem thread_tree (t : Thread) :
    commentTree (renderThread t) = commentTreeList (renderComments t.fetchedAt t.comments) := by
  unfold renderThread pageHead topNav footer a thead th storyRowT cells bodyCells commentsCell field
  cases t.story.text <;> cases t.story.url <;> cases t.story.score <;> cases t.story.author
    <;> cases t.story.time <;> cases t.story.descendants
    <;> rcases Decidable.em (t.story.type = .job) with hj | hj
    <;> simp only [hj, ite_true, ite_false]
  all_goals simp [commentTree, commentTreeList, List.lookup]

set_option maxHeartbeats 8000000 in
theorem thread_ok (t : Thread) : ThreadOk t (renderThread t) := by
  have hmem : ∀ c ∈ CTree.itemsList t.comments, c ∈ (Page.thread t).items := by
    intro c hc; simp [Page.items, hc]
  have hcomments := CTree.nodesList_all_of_wrap (commonP (.thread t)) (· ∈ (Page.thread t).items)
    (wrapShape t.fetchedAt) (fun c ds hc hds => wrap_ok _ _ c ds hc rfl hds) t.comments hmem
  have hnav := topNav_ok (.thread t)
  have hfoot := footer_ok (.thread t)
  have hsmem : t.story ∈ (Page.thread t).items := by simp [Page.items]
  have hhead : (nodes (pageHead [displayTitle t.story, " | ", "HN, formally"])).all (commonP (.thread t)) = true := by
    apply pageHead_ok
    simp only [List.all_cons, List.all_nil, Bool.and_true, Bool.and_eq_true]
    exact ⟨textOk_derived _ _ _ hsmem (derived_displayTitle _ _), by apply textOk_fixed; hn_decide,
      by apply textOk_fixed; hn_decide⟩
  have hrow := rowT_ok (.thread t) t.fetchedAt t.story hsmem rfl
  have hall : (nodes (renderThread t)).all (commonP (.thread t)) = true := by
    unfold renderThread thead th; hn_auto
  obtain ⟨hnodes, hlinks, hnamed, hlinkTags, htexts⟩ := all_commonP _ _ hall
  have hnoStory := CTree.nodesList_all_of_wrap (fun n => (n.attr "data-hn-story").isNone) (fun _ => True)
    (wrapShape t.fetchedAt) (fun c ds _ hds => wrap_noStory _ c ds hds) t.comments (fun _ _ => trivial)
  have htrees := CTree.treesOk_of_wrap t.fetchedAt (wrapShape t.fetchedAt) (wrap_tree t.fetchedAt)
    (wrap_fidelity t.fetchedAt) (wrap_marker t.fetchedAt) t.comments
  refine ⟨⟨⟨rfl, rfl, ?_, ?_, ?_, ?_, ?_, ?_, ?_, hnodes, hnamed, hlinkTags⟩, hlinks, htexts⟩, ?_, ?_⟩
  · simp [renderThread, pageHead, topNav, nodes, nodesList, isEl]
  · simp [renderThread, pageHead, nodes, nodesList, isEl, textContent, texts, textsList, concat]
    left; apply Nat.lt_add_left; decide +kernel
  · simp [renderThread, pageHead, nodes, nodesList, isCspMeta, List.lookup]
  · simp [renderThread, pageHead, nodes, nodesList, isDescriptionMeta, List.lookup]
  · simp [renderThread, pageHead, nodes, nodesList, isPreviewMeta, List.lookup]
  · simp [renderThread, pageHead, nodes, nodesList, isCardMeta, List.lookup]
  · simp [renderThread, pageHead, topNav, footer, a, nodes, nodesList, isAbout, hasAttr, List.lookup,
      textContent, texts, textsList, concat]
  · have : storyMarkers (renderThread t) = [storyRowT t.fetchedAt t.story] := by
      simp [renderThread, pageHead, topNav, footer, a, thead, th, storyMarkers, storyMarkersList,
        List.lookup, storyMarkersList_eq_nil _ hnoStory, storyRowT]
    rw [this]
    exact ⟨rowT_fidelity _ _, trivial⟩
  · rw [thread_tree t]
    exact htrees.2

/-- THE THEOREM. -/
theorem render_ok : ∀ p : Page, Spec p (render p)
  | .front f => front_ok f
  | .thread t => thread_ok t

end Render
end HnFormal
