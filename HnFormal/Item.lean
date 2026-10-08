/-!
# HN API item model

Mirrors https://github.com/HackerNews/API exactly. Every field except `id`
and `type` is optional in the API, so every field except those is optional
here. The proof in `Render.lean` quantifies over *all* values of these types.
-/
namespace HnFormal

inductive ItemType
  | job | story | comment | poll | pollopt
  deriving DecidableEq, Repr, Inhabited

def ItemType.toString : ItemType → String
  | .job => "job" | .story => "story" | .comment => "comment"
  | .poll => "poll" | .pollopt => "pollopt"

def ItemType.ofString? : String → Option ItemType
  | "job" => some .job | "story" => some .story | "comment" => some .comment
  | "poll" => some .poll | "pollopt" => some .pollopt | _ => none

structure Item where
  id : Nat
  type : ItemType
  /-- The API's `by` field (`by` is a Lean keyword). -/
  author : Option String := none
  time : Option Nat := none
  text : Option String := none
  dead : Bool := false
  deleted : Bool := false
  parent : Option Nat := none
  kids : List Nat := []
  url : Option String := none
  score : Option Nat := none
  title : Option String := none
  descendants : Option Nat := none
  parts : List Nat := []
  deriving Repr, Inhabited, DecidableEq

/-- A comment subtree, already resolved from ids to items by the fetcher.
Absent kids (cap hit, API null) are simply not present. -/
inductive CTree
  | node (item : Item) (kids : List CTree)
  deriving Repr, Inhabited

def CTree.item : CTree → Item
  | .node i _ => i

def CTree.kids : CTree → List CTree
  | .node _ ks => ks

/-- The front page: the 30 top items in API order (the spec does not fix the
number; the fetcher supplies 30). -/
structure Front where
  fetchedAt : Nat
  stories : List Item
  deriving Repr, Inhabited

/-- A discussion page: one top item and its comment forest. -/
structure Thread where
  fetchedAt : Nat
  story : Item
  comments : List CTree
  deriving Repr, Inhabited

inductive Page
  | front (f : Front)
  | thread (t : Thread)
  deriving Repr, Inhabited

mutual
def CTree.items : CTree → List Item
  | .node i ks => i :: CTree.itemsList ks
def CTree.itemsList : List CTree → List Item
  | [] => []
  | c :: cs => CTree.items c ++ CTree.itemsList cs
end

/-- Every item visible on a page. -/
def Page.items : Page → List Item
  | .front f => f.stories
  | .thread t => t.story :: CTree.itemsList t.comments

def Page.fetchedAt : Page → Nat
  | .front f => f.fetchedAt
  | .thread t => t.fetchedAt

end HnFormal
