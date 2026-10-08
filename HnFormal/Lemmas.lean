import Lean
import HnFormal.Spec
/-!
# Lemma library for renderer proofs

Everything a renderer proof needs that is not `simp`. Written once; the loop
may not edit it. The pattern every proof follows:

1. `Structure`/links/text are *all-nodes* properties. Prove
   `(nodes d).all P = true` and derive the rest with `all_texts_of_nodes`,
   `all_byTag_of_nodes`.
2. Lists of stories are rendered with `List.map`; use `nodesList_map`,
   `all_flatMap`, `storiesOk_map`.
3. Comment trees are rendered with a `wrap` function and a mutual
   `renderComment`/`renderComments` pair; use `CTree.nodes_all_of_wrap` and
   `CTree.treesOk_of_wrap`, which do the induction for you.
-/
namespace HnFormal
open Dom Spec

/-! ## List helpers -/

theorem all_flatMap {α β} (l : List α) (g : α → List β) (P : β → Bool)
    (h : ∀ x ∈ l, (g x).all P = true) : (l.flatMap g).all P = true := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    simp only [List.flatMap_cons, List.all_append, Bool.and_eq_true]
    exact ⟨h x (by simp), ih fun y hy => h y (by simp [hy])⟩

@[simp] theorem flatMap_fun_nil {α β} (l : List α) : (l.flatMap fun _ => ([] : List β)) = [] := by
  induction l with
  | nil => rfl
  | cons x xs ih => simp [ih]

theorem flatMap_singleton_eq_map {α β} (l : List α) (g : α → β) :
    (l.flatMap fun x => [g x]) = l.map g := by
  induction l with
  | nil => rfl
  | cons x xs ih => simp [ih]

theorem filter_flatMap {α β} (l : List α) (g : α → List β) (P : β → Bool) :
    (l.flatMap g).filter P = l.flatMap fun x => (g x).filter P := by
  induction l with
  | nil => rfl
  | cons x xs ih => simp [List.filter_append, ih]

/-! ## Attributes -/

@[simp] theorem attr_el (k t : String) (a : List (String × String)) (cs : List Dom) :
    attr k (.el t a cs) = a.lookup k := rfl
@[simp] theorem attr_text (k s : String) : attr k (.text s) = none := rfl
@[simp] theorem tag_el (t : String) (a : List (String × String)) (cs : List Dom) :
    tag (.el t a cs) = some t := rfl
@[simp] theorem tag_text (s : String) : tag (.text s) = none := rfl
@[simp] theorem children_el (t : String) (a : List (String × String)) (cs : List Dom) :
    children (.el t a cs) = cs := rfl

/-! ## Non-blank display strings -/

theorem nonblank_nonempty (f s : String) (hf : (trimS f).isEmpty = false) :
    (trimS (nonblank f s)).isEmpty = false := by
  unfold nonblank
  split
  · exact hf
  · rename_i h; simpa using h

theorem displayTitle_nonempty (s : Item) : (trimS (displayTitle s)).isEmpty = false :=
  nonblank_nonempty _ _ (by decide +kernel)

theorem displayUser_nonempty (u : String) : (trimS (displayUser u)).isEmpty = false :=
  nonblank_nonempty _ _ (by decide +kernel)

/-! ## Node lists -/

theorem nodesList_append (xs ys : List Dom) :
    nodesList (xs ++ ys) = nodesList xs ++ nodesList ys := by
  induction xs with
  | nil => simp [nodesList]
  | cons x xs ih => simp [nodesList, ih]

theorem nodesList_map {α} (l : List α) (g : α → Dom) :
    nodesList (l.map g) = l.flatMap fun x => nodes (g x) := by
  induction l with
  | nil => rfl
  | cons x xs ih => simp [nodesList, ih]

theorem nodesList_singleton (d : Dom) : nodesList [d] = nodes d := by
  simp [nodesList]

theorem textsList_append (xs ys : List Dom) :
    textsList (xs ++ ys) = textsList xs ++ textsList ys := by
  induction xs with
  | nil => simp [textsList]
  | cons x xs ih => simp [textsList, ih]

theorem ownNodesList_append (xs ys : List Dom) :
    ownNodesList (xs ++ ys) = ownNodesList xs ++ ownNodesList ys := by
  induction xs with
  | nil => simp [ownNodesList]
  | cons x xs ih => simp [ownNodesList, ih]

theorem commentTreeList_append (xs ys : List Dom) :
    commentTreeList (xs ++ ys) = commentTreeList xs ++ commentTreeList ys := by
  induction xs with
  | nil => simp [commentTreeList]
  | cons x xs ih => simp [commentTreeList, ih]

def textOf : Dom → Option String
  | .text s => some s
  | .el _ _ _ => none

mutual
/-- Text nodes are the text-valued nodes, in order. -/
theorem texts_eq : ∀ d : Dom, texts d = (nodes d).filterMap textOf
  | .text s => by simp [texts, nodes, textOf]
  | .el t a cs => by
    simp only [texts, nodes, List.filterMap_cons]
    simp [textOf, textsList_eq cs]
theorem textsList_eq : ∀ ds : List Dom, textsList ds = (nodesList ds).filterMap textOf
  | [] => by simp [textsList, nodesList]
  | d :: ds => by simp [textsList, nodesList, List.filterMap_append, texts_eq d, textsList_eq ds]
end

def textNodeOk (P : String → Bool) : Dom → Bool
  | .text s => P s
  | .el _ _ _ => true

theorem all_texts_of_nodes (P : String → Bool) (d : Dom)
    (h : (nodes d).all (textNodeOk P) = true) : (texts d).all P = true := by
  rw [texts_eq]
  rw [List.all_eq_true] at h ⊢
  intro s hs
  rw [List.mem_filterMap] at hs
  obtain ⟨n, hn, hns⟩ := hs
  have := h n hn
  cases n with
  | text t => simp [textOf] at hns; subst hns; simpa [textNodeOk] using this
  | el _ _ _ => simp [textOf] at hns

theorem all_byTag_of_nodes (t : String) (P : Dom → Bool) (d : Dom)
    (h : (nodes d).all (fun n => !isEl t n || P n) = true) : (byTag t d).all P = true := by
  unfold byTag
  rw [List.all_eq_true] at h ⊢
  intro n hn
  rw [List.mem_filter] at hn
  have := h n hn.1
  simp [hn.2] at this
  exact this

theorem storyMarkersList_append (xs ys : List Dom) :
    storyMarkersList (xs ++ ys) = storyMarkersList xs ++ storyMarkersList ys := by
  induction xs with
  | nil => simp [storyMarkersList]
  | cons x xs ih => simp [storyMarkersList, ih]

theorem storyMarkersList_map {α} (l : List α) (g : α → Dom) :
    storyMarkersList (l.map g) = l.flatMap fun x => storyMarkers (g x) := by
  induction l with
  | nil => rfl
  | cons x xs ih => simp [storyMarkersList, ih]

theorem commentTreeList_map {α} (l : List α) (g : α → Dom) :
    commentTreeList (l.map g) = l.flatMap fun x => commentTree (g x) := by
  induction l with
  | nil => rfl
  | cons x xs ih => simp [commentTreeList, ih]

/-- A list of markers contributes no own-nodes. -/
theorem ownNodesList_eq_nil_of_markers (ds : List Dom) (h : ∀ d ∈ ds, isMarker d = true) :
    ownNodesList ds = [] := by
  induction ds with
  | nil => rfl
  | cons d ds ih =>
    simp only [ownNodesList, h d (by simp)]
    simp [ih fun x hx => h x (by simp [hx])]

mutual
theorem mem_ownNodes (n : Dom) : ∀ d : Dom, n ∈ ownNodes d → n ∈ nodes d
  | .text s => by simp [ownNodes, nodes]
  | .el t a cs => by
    intro h
    simp only [ownNodes, nodes, List.mem_cons] at h ⊢
    rcases h with h | h
    · exact Or.inl h
    · exact Or.inr (mem_ownNodesList n cs h)
theorem mem_ownNodesList (n : Dom) : ∀ ds : List Dom, n ∈ ownNodesList ds → n ∈ nodesList ds
  | [] => by simp [ownNodesList, nodesList]
  | d :: ds => by
    intro h
    simp only [ownNodesList, nodesList, List.mem_append] at h ⊢
    rcases h with h | h
    · split at h
      · simp at h
      · exact Or.inl (mem_ownNodes n d h)
    · exact Or.inr (mem_ownNodesList n ds h)
end

/-! No-marker trees have empty marker lists. -/
mutual
theorem storyMarkers_eq_nil (d : Dom) (h : (nodes d).all (fun n => (n.attr "data-hn-story").isNone) = true) :
    storyMarkers d = [] := by
  cases d with
  | text s => rfl
  | el t a cs =>
    simp only [nodes, List.all_cons, Bool.and_eq_true] at h
    simp only [storyMarkers]
    have : (a.lookup "data-hn-story").isSome = false := by
      have h1 := h.1; simp only [attr, Option.isNone_iff_eq_none] at h1; simp [h1]
    simp only [this, Bool.false_eq_true, ite_false]
    exact storyMarkersList_eq_nil cs h.2
theorem storyMarkersList_eq_nil (ds : List Dom) (h : (nodesList ds).all (fun n => (n.attr "data-hn-story").isNone) = true) :
    storyMarkersList ds = [] := by
  cases ds with
  | nil => rfl
  | cons d ds =>
    simp only [nodesList, List.all_append, Bool.and_eq_true] at h
    simp only [storyMarkersList, storyMarkers_eq_nil d h.1, storyMarkersList_eq_nil ds h.2, List.nil_append]
end

mutual
theorem commentTree_eq_nil (d : Dom) (h : (nodes d).all (fun n => (n.attr "data-hn-comment").isNone) = true) :
    commentTree d = [] := by
  cases d with
  | text s => rfl
  | el t a cs =>
    simp only [nodes, List.all_cons, Bool.and_eq_true] at h
    simp only [commentTree]
    have : (a.lookup "data-hn-comment").isSome = false := by
      have h1 := h.1; simp only [attr, Option.isNone_iff_eq_none] at h1; simp [h1]
    simp only [this, Bool.false_eq_true, ite_false]
    exact commentTreeList_eq_nil cs h.2
theorem commentTreeList_eq_nil (ds : List Dom) (h : (nodesList ds).all (fun n => (n.attr "data-hn-comment").isNone) = true) :
    commentTreeList ds = [] := by
  cases ds with
  | nil => rfl
  | cons d ds =>
    simp only [nodesList, List.all_append, Bool.and_eq_true] at h
    simp only [commentTreeList, commentTree_eq_nil d h.1, commentTreeList_eq_nil ds h.2, List.nil_append]
end

/-! ## Links and text -/

theorem hrefOk_fixed (p : Page) (h : String) (hh : fixedHrefs.contains h = true) :
    hrefOk p h = true := by
  simp only [hrefOk, Bool.or_eq_true]; exact Or.inl hh

theorem hrefOk_item (p : Page) (i : Item) (h : String)
    (hi : i ∈ p.items) (hh : (itemHrefs i).contains h = true) : hrefOk p h = true := by
  simp only [hrefOk, Bool.or_eq_true, List.any_eq_true]
  exact Or.inr ⟨i, hi, hh⟩

def hrefOkOpt (p : Page) : Option String → Bool
  | none => true
  | some h => hrefOk p h

theorem linkOk_of_href (p : Page) (a : Dom)
    (h : ∀ u, a.attr "href" = some u → hrefOk p u = true) : linkOk p a = true := by
  unfold linkOk
  split
  · rfl
  · rename_i u hu; exact h u hu

theorem textOk_fixed (p : Page) (t : String) (h : fixedText.any (· == trimS t) = true) :
    textOk p t = true := by
  simp only [textOk, Bool.or_eq_true]
  exact Or.inl (Or.inr h)

theorem textOk_derived (p : Page) (i : Item) (t : String)
    (hi : i ∈ p.items) (ht : t ∈ derivedText p.fetchedAt i) : textOk p t = true := by
  simp only [textOk, Bool.or_eq_true, List.any_eq_true]
  exact Or.inr ⟨i, hi, t, ht, by simp⟩

theorem textOk_empty (p : Page) (t : String) (h : (trimS t).isEmpty = true) : textOk p t = true := by
  simp only [textOk, Bool.or_eq_true]
  exact Or.inl (Or.inl h)

/-! ## Stories -/

theorem storiesOk_map (b : Bool) (now : Nat) (l : List Item) (g : Item → Dom)
    (h : ∀ s ∈ l, StoryOk b now s (g s)) : StoriesOk b now l (l.map g) := by
  induction l with
  | nil => trivial
  | cons s ss ih =>
    exact ⟨h s (by simp), ih fun x hx => h x (by simp [hx])⟩

theorem concat_single (s : String) : concat [s] = s := by simp [concat]

theorem concat_nil : concat [] = "" := rfl

/-! ## Comment trees -/

theorem CTree.items_subset_itemsList (t : CTree) (ks : List CTree) (h : t ∈ ks) :
    ∀ c ∈ t.items, c ∈ CTree.itemsList ks := by
  induction ks with
  | nil => simp at h
  | cons k ks ih =>
    intro c hc
    simp only [CTree.itemsList, List.mem_append]
    rcases List.mem_cons.1 h with rfl | h
    · exact Or.inl hc
    · exact Or.inr (ih h c hc)

theorem CTree.mem_items_self (c : Item) (ks : List CTree) : c ∈ (CTree.node c ks).items := by
  simp [CTree.items]

theorem CTree.itemsList_subset (c : Item) (ks : List CTree) :
    ∀ x ∈ CTree.itemsList ks, x ∈ (CTree.node c ks).items := by
  intro x hx; simp [CTree.items, hx]

/-- The shape every comment renderer has: a `wrap` applied to the item and
the rendered kids. -/
structure WrapShape (wrap : Item → List Dom → Dom) (rc : CTree → Dom) (rcl : List CTree → List Dom) : Prop where
  rc_eq : ∀ c ks, rc (.node c ks) = wrap c (rcl ks)
  rcl_nil : rcl [] = []
  rcl_cons : ∀ k ks, rcl (k :: ks) = rc k :: rcl ks

section WrapLemmas
variable (P : Dom → Bool) (Q : Item → Prop) {wrap : Item → List Dom → Dom} {rc : CTree → Dom} {rcl : List CTree → List Dom}

mutual
/-- All-nodes properties lift through any wrap-shaped renderer. `Q` carries
whatever you know about items (typically membership in the page). -/
theorem CTree.nodes_all_of_wrap (hs : WrapShape wrap rc rcl)
    (hw : ∀ c ds, Q c → (nodesList ds).all P = true → (nodes (wrap c ds)).all P = true) :
    ∀ t : CTree, (∀ c ∈ t.items, Q c) → (nodes (rc t)).all P = true
  | .node c ks => by
    intro hq
    rw [hs.rc_eq]
    exact hw c _ (hq c (CTree.mem_items_self c ks))
      (CTree.nodesList_all_of_wrap hs hw ks fun x hx => hq x (CTree.itemsList_subset c ks x hx))
theorem CTree.nodesList_all_of_wrap (hs : WrapShape wrap rc rcl)
    (hw : ∀ c ds, Q c → (nodesList ds).all P = true → (nodes (wrap c ds)).all P = true) :
    ∀ ks : List CTree, (∀ c ∈ CTree.itemsList ks, Q c) → (nodesList (rcl ks)).all P = true
  | [] => by intro _; rw [hs.rcl_nil]; simp [nodesList]
  | k :: ks => by
    intro hq
    rw [hs.rcl_cons]
    simp only [nodesList, List.all_append, Bool.and_eq_true]
    refine ⟨CTree.nodes_all_of_wrap hs hw k fun c hc => hq c ?_,
            CTree.nodesList_all_of_wrap hs hw ks fun c hc => hq c ?_⟩
    · simp [CTree.itemsList, hc]
    · simp [CTree.itemsList, hc]
end

variable (now : Nat)

mutual
/-- Fidelity lifts through any wrap-shaped renderer whose wrap is a marker
containing exactly the kids' markers. -/
theorem CTree.treeOk_of_wrap (hs : WrapShape wrap rc rcl)
    (htree : ∀ c ds, commentTree (wrap c ds) = [.node (wrap c ds) (commentTreeList ds)])
    (hok : ∀ c ds, (∀ d ∈ ds, isMarker d = true) → CommentOk now c (wrap c ds))
    (hmarker : ∀ c ds, isMarker (wrap c ds) = true) :
    ∀ t : CTree, commentTree (rc t) = [.node (rc t) (commentTreeList (rcl t.kids))] ∧
                 isMarker (rc t) = true ∧ TreeOk now t (.node (rc t) (commentTreeList (rcl t.kids)))
  | .node c ks => by
    have ih := CTree.treesOk_of_wrap hs htree hok hmarker ks
    refine ⟨?_, ?_, ?_⟩
    · simp only [CTree.kids]; rw [hs.rc_eq]; exact htree c _
    · rw [hs.rc_eq]; exact hmarker c _
    · simp only [CTree.kids, TreeOk]
      rw [hs.rc_eq]
      exact ⟨hok c _ ih.1, ih.2⟩
theorem CTree.treesOk_of_wrap (hs : WrapShape wrap rc rcl)
    (htree : ∀ c ds, commentTree (wrap c ds) = [.node (wrap c ds) (commentTreeList ds)])
    (hok : ∀ c ds, (∀ d ∈ ds, isMarker d = true) → CommentOk now c (wrap c ds))
    (hmarker : ∀ c ds, isMarker (wrap c ds) = true) :
    ∀ ks : List CTree, (∀ d ∈ rcl ks, isMarker d = true) ∧ TreesOk now ks (commentTreeList (rcl ks))
  | [] => by rw [hs.rcl_nil]; exact ⟨by simp, trivial⟩
  | k :: ks => by
    have ih1 := CTree.treeOk_of_wrap hs htree hok hmarker k
    have ih2 := CTree.treesOk_of_wrap hs htree hok hmarker ks
    rw [hs.rcl_cons]
    refine ⟨?_, ?_⟩
    · intro d hd
      rcases List.mem_cons.1 hd with rfl | hd
      · exact ih1.2.1
      · exact ih2.1 d hd
    · simp only [commentTreeList]
      rw [ih1.1]
      simp only [List.singleton_append, TreesOk]
      exact ⟨ih1.2.2, ih2.2⟩
end

end WrapLemmas

/-! ## Derived values -/

theorem derived_title (now : Nat) (s : Item) : plainTitle s ∈ derivedText now s := by
  simp [derivedText]
theorem derived_displayTitle (now : Nat) (s : Item) : displayTitle s ∈ derivedText now s := by
  simp [derivedText]
theorem derived_id (now : Nat) (s : Item) : toString s.id ∈ derivedText now s := by
  simp [derivedText]
theorem derived_displayUser (now : Nat) (s : Item) (u : String) (h : s.author = some u) :
    displayUser u ∈ derivedText now s := by simp [derivedText, h]
theorem derived_author (now : Nat) (s : Item) (u : String) (h : s.author = some u) :
    u ∈ derivedText now s := by simp [derivedText, h]
theorem derived_score (now : Nat) (s : Item) (n : Nat) (h : s.score = some n) :
    toString n ∈ derivedText now s := by simp [derivedText, h]
theorem derived_descendants (now : Nat) (s : Item) (n : Nat) (h : s.descendants = some n) :
    toString n ∈ derivedText now s := by simp [derivedText, h]
theorem derived_url (now : Nat) (s : Item) (u : String) (h : s.url = some u) :
    u ∈ derivedText now s := by simp [derivedText, h]
theorem derived_domain (now : Nat) (s : Item) (u : String) (h : s.url = some u) :
    domainOf u ∈ derivedText now s := by simp [derivedText, h]
theorem derived_age (now : Nat) (s : Item) (t : Nat) (h : s.time = some t) :
    ageString now t ∈ derivedText now s := by simp [derivedText, h]
theorem derived_body (now : Nat) (s : Item) (x : String) (h : x ∈ textsList (itemBody s)) :
    x ∈ derivedText now s := by simp [derivedText, h]

theorem itemHrefs_item (s : Item) : (itemHrefs s).contains (itemHref s.id) = true := by
  simp [itemHrefs]
theorem itemHrefs_user (s : Item) (u : String) (h : s.author = some u) :
    (itemHrefs s).contains (userHref u) = true := by simp [itemHrefs, h]
theorem itemHrefs_url (s : Item) (u : String) (h : s.url = some u) :
    (itemHrefs s).contains (Sanitize.encodeHref u) = true := by simp [itemHrefs, h]
theorem itemHrefs_title (s : Item) : (itemHrefs s).contains (titleHref s) = true := by
  unfold titleHref
  cases h : s.url with
  | none => simp [itemHrefs]
  | some u => simp [itemHrefs, h]
theorem itemHrefs_body (s : Item) (u : String) (h : u ∈ hrefsIn (itemBody s)) :
    (itemHrefs s).contains u = true := by simp [itemHrefs, h]

/-! ## The all-nodes predicate -/

/-- One predicate that implies the three all-nodes conjuncts of `Common`. -/
def commonP (p : Page) (n : Dom) : Bool :=
  nodeOk n && (!isEl "a" n || (linkOk p n && anchorNamed n)) && (!isEl "link" n || linkTagOk n) &&
  textNodeOk (textOk p) n

theorem all_commonP (p : Page) (d : Dom) (h : (nodes d).all (commonP p) = true) :
    (nodes d).all nodeOk = true ∧ ((byTag "a" d).all (linkOk p)) = true ∧
    ((byTag "a" d).all anchorNamed) = true ∧
    ((byTag "link" d).all linkTagOk) = true ∧ (texts d).all (textOk p) = true := by
  have h' := List.all_eq_true.1 h
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · exact List.all_eq_true.2 fun n hn => by
      have := h' n hn; simp only [commonP, Bool.and_eq_true] at this; exact this.1.1.1
  · exact all_byTag_of_nodes "a" _ d (List.all_eq_true.2 fun n hn => by
      have := h' n hn; simp only [commonP, Bool.and_eq_true, Bool.or_eq_true] at this
      rcases this.1.1.2 with h1 | h1
      · simp [h1]
      · simp [h1.1])
  · exact all_byTag_of_nodes "a" _ d (List.all_eq_true.2 fun n hn => by
      have := h' n hn; simp only [commonP, Bool.and_eq_true, Bool.or_eq_true] at this
      rcases this.1.1.2 with h1 | h1
      · simp [h1]
      · simp [h1.2])
  · exact all_byTag_of_nodes "link" _ d (List.all_eq_true.2 fun n hn => by
      have := h' n hn; simp only [commonP, Bool.and_eq_true] at this; exact this.1.2)
  · exact all_texts_of_nodes _ d (List.all_eq_true.2 fun n hn => by
      have := h' n hn; simp only [commonP, Bool.and_eq_true] at this; exact this.2)

@[simp] theorem nodeOk_el_eq (t : String) (at_ : List (String × String)) (cs : List Dom) :
    nodeOk (.el t at_ cs) = (allowedTags.contains t && at_.all attrOk) := rfl

@[simp] theorem nodeOk_text_eq (s : String) : nodeOk (.text s) = true := rfl

@[simp] theorem attrOk_mk (k v : String) : attrOk (k, v) = attrNameOk k := rfl

@[simp] theorem commonP_text (p : Page) (s : String) : commonP p (.text s) = textOk p s := by
  simp [commonP, nodeOk, isEl, tag, textNodeOk]

@[simp] theorem commonP_el (p : Page) (t : String) (at_ : List (String × String)) (cs : List Dom) :
    commonP p (.el t at_ cs) = (nodeOk (.el t at_ cs)
      && (!(t == "a") || (hrefOkOpt p (at_.lookup "href") && anchorNamed (.el t at_ cs)))
      && (!(t == "link") || linkTagOk (.el t at_ cs))) := by
  simp [commonP, isEl, tag, textNodeOk, linkOk, attr, hrefOkOpt]
  cases at_.lookup "href" <;> simp

/-- All-nodes of a `List.map` over items with a membership hypothesis. -/
theorem all_nodesList_map {α} (P : Dom → Bool) (l : List α) (g : α → Dom)
    (h : ∀ x ∈ l, (nodes (g x)).all P = true) : (nodesList (l.map g)).all P = true := by
  rw [nodesList_map]; exact all_flatMap l _ P h

theorem storyMarkers_map_of (fixed : List Dom) (l : List Item) (g : Item → Dom)
    (hfixed : (nodesList fixed).filter (fun n => (n.attr "data-hn-story").isSome) = [])
    (hg : ∀ s, (nodes (g s)).filter (fun n => (n.attr "data-hn-story").isSome) = [g s]) :
    (nodesList (fixed ++ l.map g)).filter (fun n => (n.attr "data-hn-story").isSome) = l.map g := by
  rw [nodesList_append, List.filter_append, hfixed, List.nil_append, nodesList_map, filter_flatMap]
  simp only [hg]
  exact flatMap_singleton_eq_map l g

/-! ## Automation

`hn_auto` closes the goals that remain after unfolding a renderer: literal
tag/attribute/text checks by `decide`, derived text by the `derived_*`
lemmas, and hrefs by the `itemHrefs_*` lemmas. It expects a hypothesis
`_ ∈ p.items` for the item in scope and `h : s.field = some x` equations
from `cases h : s.field`.
-/

open Lean Elab Tactic in
/-- `decide`, but only on closed goals; fails immediately otherwise so it
cannot grind on a goal it can never close. -/
elab "hn_decide" : tactic => do
  let g ← getMainTarget
  let g ← instantiateMVars g
  if g.hasFVar || g.hasMVar then throwError "hn_decide: goal has free variables"
  evalTactic (← `(tactic| decide +kernel))

syntax "hn_leaf" : tactic
macro_rules
  | `(tactic| hn_leaf) => `(tactic| first
      | assumption
      | exact True.intro
      | hn_decide
      | omega
      | (apply textOk_empty; hn_decide)
      | (apply textOk_fixed; hn_decide)
      | (apply hrefOk_fixed; hn_decide)
      | exact displayTitle_nonempty _
      | exact displayUser_nonempty _
      | exact Or.inl (displayTitle_nonempty _)
      | exact Or.inl (displayUser_nonempty _)
      | (apply textOk_derived <;> first
          | assumption
          | exact derived_title _ _
          | exact derived_displayTitle _ _
          | (apply derived_displayUser; assumption)
          | exact derived_id _ _
          | (apply derived_author; assumption)
          | (apply derived_score; assumption)
          | (apply derived_descendants; assumption)
          | (apply derived_url; assumption)
          | (apply derived_domain; assumption)
          | (apply derived_age; assumption)
          | (apply derived_body; assumption))
      | (apply hrefOk_item <;> first
          | assumption
          | exact itemHrefs_item _
          | exact itemHrefs_title _
          | (apply itemHrefs_user; assumption)
          | (apply itemHrefs_url; assumption)
          | (apply itemHrefs_body; assumption)))

syntax "hn_simp" : tactic
macro_rules
  | `(tactic| hn_simp) => `(tactic| (
      simp only [nodes, nodesList, nodesList_append, List.flatMap_nil, List.flatMap_cons,
        List.map_nil, List.map_cons, Option.toList, List.all_append, List.all_cons, List.all_nil,
        List.nil_append, List.cons_append, List.append_nil, List.append_assoc,
        commonP_text, commonP_el, nodeOk_el_eq, nodeOk_text_eq, attrOk_mk, Bool.and_eq_true, Bool.and_true, Bool.true_and,
        Bool.or_eq_true, Bool.not_eq_true', Bool.not_true, Bool.not_false,
        Bool.false_or, Bool.true_or, Bool.or_true, Bool.or_false,
        List.lookup, hrefOkOpt, beq_self_eq_true, Prod.mk.injEq,
        String.reduceBEq, reduceIte, ite_true, ite_false, and_true, true_and, and_self, textNodeOk,
        linkTagOk, attr_el, attr_text, Option.some.injEq, anchorNamed, textContent, texts, textsList,
        concat, String.append_empty, Option.isSome_none, Option.isSome_some]
      ))

syntax "hn_auto" : tactic
macro_rules
  | `(tactic| hn_auto) => `(tactic| (
      hn_simp
      all_goals (repeat' apply And.intro)
      all_goals hn_leaf))

/-! ## Sanitized bodies -/

theorem sbody_nodeOk (x : String) (n : Dom) (hn : n ∈ nodesList (Sanitize.body x)) :
    Sanitize.nodeOk n = true := by
  have hn' : n ∈ nodesList (Sanitize.toDom (Sanitize.parse x)) := by
    unfold Sanitize.body at hn; exact hn
  exact Sanitize.toDom_ok _ n hn'

theorem body_nodeOk (i : Item) (n : Dom) (hn : n ∈ nodesList (itemBody i)) :
    Sanitize.nodeOk n = true := sbody_nodeOk _ n hn

theorem sbody_no_attr (x : String) (n : Dom) (hn : n ∈ nodesList (Sanitize.body x)) (k : String)
    (hk : k ≠ "href" ∧ k ≠ "rel") : n.attr k = none := by
  have h := sbody_nodeOk x n hn
  cases n with
  | text _ => rfl
  | el t a cs =>
    simp only [Sanitize.nodeOk, Bool.and_eq_true] at h
    have ha := h.1.2
    simp only [attr]
    unfold Sanitize.attrsOk at ha
    split at ha
    · split at ha
      · rename_i h' u
        have h1 : (k == "href") = false := beq_eq_false_iff_ne.2 hk.1
        have h2 : (k == "rel") = false := beq_eq_false_iff_ne.2 hk.2
        simp [List.lookup, h1, h2]
      · simp at ha
    · simp [List.isEmpty_iff.1 ha]

theorem body_no_attr (i : Item) (n : Dom) (hn : n ∈ nodesList (itemBody i)) (k : String)
    (hk : k ≠ "href" ∧ k ≠ "rel") : n.attr k = none := sbody_no_attr _ n hn k hk

theorem sbody_no_story (x : String) :
    (nodesList (Sanitize.body x)).all (fun n => (n.attr "data-hn-story").isNone) = true :=
  List.all_eq_true.2 fun n hn => by simp [sbody_no_attr x n hn "data-hn-story" (by decide)]

theorem sbody_no_comment (x : String) :
    (nodesList (Sanitize.body x)).all (fun n => (n.attr "data-hn-comment").isNone) = true :=
  List.all_eq_true.2 fun n hn => by simp [sbody_no_attr x n hn "data-hn-comment" (by decide)]

theorem body_no_story (i : Item) :
    (nodesList (itemBody i)).all (fun n => (n.attr "data-hn-story").isNone) = true := sbody_no_story _

theorem body_no_comment (i : Item) :
    (nodesList (itemBody i)).all (fun n => (n.attr "data-hn-comment").isNone) = true := sbody_no_comment _

@[simp] theorem sbody_storyMarkers (x : String) : storyMarkersList (Sanitize.body x) = [] :=
  storyMarkersList_eq_nil _ (sbody_no_story x)

@[simp] theorem sbody_commentTree (x : String) : commentTreeList (Sanitize.body x) = [] :=
  commentTreeList_eq_nil _ (sbody_no_comment x)

theorem body_storyMarkers (i : Item) : storyMarkersList (itemBody i) = [] := sbody_storyMarkers _
theorem body_commentTree (i : Item) : commentTreeList (itemBody i) = [] := sbody_commentTree _

theorem mem_nodesList_of_mem (d : Dom) (ds : List Dom) (hd : d ∈ ds) : d ∈ nodesList ds := by
  induction ds with
  | nil => simp at hd
  | cons x xs ih =>
    simp only [nodesList, List.mem_append]
    rcases List.mem_cons.1 hd with rfl | hd
    · exact Or.inl (by cases d <;> simp [nodes])
    · exact Or.inr (ih hd)

theorem sbody_no_marker (x : String) (d : Dom) (hd : d ∈ Sanitize.body x) : isMarker d = false := by
  have hn := mem_nodesList_of_mem d _ hd
  simp [isMarker, sbody_no_attr x d hn "data-hn-story" (by decide), sbody_no_attr x d hn "data-hn-comment" (by decide)]

theorem body_no_marker (i : Item) (d : Dom) (hd : d ∈ itemBody i) : isMarker d = false :=
  sbody_no_marker _ d hd

/-- Own-nodes of a body carry no `data-hn` attribute, so field lookups
inside a body find nothing. -/
@[simp] theorem sbody_findOwn (x : String) (v : String) :
    (ownNodesList (Sanitize.body x)).filter (hasAttr "data-hn" v) = [] := by
  rw [List.filter_eq_nil_iff]
  intro n hn
  have := sbody_no_attr x n (mem_ownNodesList n _ hn) "data-hn" (by decide)
  simp [hasAttr, this]

theorem body_findOwn (i : Item) (v : String) :
    (ownNodesList (itemBody i)).filter (hasAttr "data-hn" v) = [] := sbody_findOwn _ v

/-- A body's nodes satisfy the all-nodes predicate for any page containing
its item. -/
theorem body_commonP (p : Page) (i : Item) (hi : i ∈ p.items) :
    (nodesList (itemBody i)).all (commonP p) = true := by
  rw [List.all_eq_true]
  intro n hn
  have h := body_nodeOk i n hn
  cases n with
  | text s =>
    rw [commonP_text]
    apply textOk_derived p i s hi
    apply derived_body
    rw [textsList_eq, List.mem_filterMap]
    exact ⟨.text s, hn, rfl⟩
  | el t a cs =>
    simp only [Sanitize.nodeOk, Bool.and_eq_true] at h
    obtain ⟨⟨ht, ha⟩, hname⟩ := h
    unfold Sanitize.tagOk at ht
    unfold Sanitize.attrsOk at ha
    unfold Sanitize.namedOk at hname
    simp only [Bool.or_eq_true, beq_iff_eq] at ht
    rcases ht with (((((rfl | rfl) | rfl) | rfl) | rfl) | rfl) | rfl
    all_goals simp only [reduceIte, String.reduceBEq] at ha
    all_goals try (have ha' := List.isEmpty_iff.1 ha; subst ha'; hn_auto)
    -- the anchor case
    split at ha
    · rename_i u
      simp only [String.reduceBEq, Bool.not_true, Bool.false_or, Bool.not_eq_true'] at hname
      have hu : u ∈ hrefsIn (itemBody i) := by
        simp only [hrefsIn, List.mem_filterMap]
        exact ⟨.el "a" [("href", u), ("rel", "nofollow")] cs, hn, by simp [isEl, tag, attr, List.lookup]⟩
      hn_auto
    · simp at ha

end HnFormal
