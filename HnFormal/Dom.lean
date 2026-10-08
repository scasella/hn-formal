import HnFormal.Item
/-!
# DOM trees

The renderer produces a `Dom`, never a string. The serializer in `Html.lean`
turns it into bytes and is proven to escape text and attribute values.
-/
namespace HnFormal

inductive Dom
  | text (s : String)
  | el (tag : String) (attrs : List (String × String)) (children : List Dom)
  deriving Repr, Inhabited

namespace Dom

/-! All nodes in preorder, including the root. -/
mutual
def nodes : Dom → List Dom
  | .text s => [.text s]
  | .el t a cs => .el t a cs :: nodesList cs
def nodesList : List Dom → List Dom
  | [] => []
  | d :: ds => nodes d ++ nodesList ds
end

/-! All text node contents in document order. -/
mutual
def texts : Dom → List String
  | .text s => [s]
  | .el _ _ cs => textsList cs
def textsList : List Dom → List String
  | [] => []
  | d :: ds => texts d ++ textsList ds
end

def concat : List String → String
  | [] => ""
  | s :: ss => s ++ concat ss

/-- Concatenated text content. -/
def textContent (d : Dom) : String := concat (texts d)

def attr (name : String) : Dom → Option String
  | .text _ => none
  | .el _ a _ => a.lookup name

def tag : Dom → Option String
  | .text _ => none
  | .el t _ _ => some t

def isEl (t : String) (d : Dom) : Bool := d.tag == some t

def hasAttr (name value : String) (d : Dom) : Bool := d.attr name == some value

/-- Count of elements with a given tag anywhere in the tree. -/
def countTag (t : String) (d : Dom) : Nat :=
  (nodes d).countP (isEl t)

/-- Elements (anywhere) with the given attribute value. -/
def findAttr (name value : String) (d : Dom) : List Dom :=
  (nodes d).filter (hasAttr name value)

/-- Elements with the given tag anywhere in the tree. -/
def byTag (t : String) (d : Dom) : List Dom :=
  (nodes d).filter (isEl t)

/-- A comment marker node together with the marker nodes nested in it. -/
inductive CView
  | node (m : Dom) (kids : List CView)
  deriving Inhabited

/-! The tree of `data-hn-comment` markers, preserving nesting: a marked node
becomes a `CView` whose kids are the marked nodes found among its
descendants (nearest marker wins); unmarked nodes are transparent. -/
mutual
def commentTree : Dom → List CView
  | .text _ => []
  | .el t a cs =>
    if (a.lookup "data-hn-comment").isSome then [.node (.el t a cs) (commentTreeList cs)]
    else commentTreeList cs
def commentTreeList : List Dom → List CView
  | [] => []
  | d :: ds => commentTree d ++ commentTreeList ds
end

def children : Dom → List Dom
  | .text _ => []
  | .el _ _ cs => cs

/-- A node carrying a story or comment marker. -/
def isMarker (d : Dom) : Bool :=
  (d.attr "data-hn-story").isSome || (d.attr "data-hn-comment").isSome

/-! Nodes of a subtree that are not inside a *nested* marker. The root is
always included. This lets the spec talk about a comment's own fields
without seeing its children's. -/
mutual
def ownNodes : Dom → List Dom
  | .text s => [.text s]
  | .el t a cs => .el t a cs :: ownNodesList cs
def ownNodesList : List Dom → List Dom
  | [] => []
  | d :: ds => (if isMarker d then [] else ownNodes d) ++ ownNodesList ds
end

/-- Own elements with `name=value`. -/
def findOwn (name value : String) (d : Dom) : List Dom :=
  (ownNodes d).filter (hasAttr name value)

/-! Story markers in document order; a marker's own subtree is not searched
(nearest marker wins), so nested markers do not count. -/
mutual
def storyMarkers : Dom → List Dom
  | .text _ => []
  | .el t a cs =>
    if (a.lookup "data-hn-story").isSome then [.el t a cs] else storyMarkersList cs
def storyMarkersList : List Dom → List Dom
  | [] => []
  | d :: ds => storyMarkers d ++ storyMarkersList ds
end

/-- Comment markers in document (= preorder) order. -/
def commentMarkers (d : Dom) : List Dom :=
  (nodes d).filter fun n => (n.attr "data-hn-comment").isSome

/-- All `href` values of `a` elements in a list of trees. -/
def hrefsIn (ds : List Dom) : List String :=
  (nodesList ds).filterMap fun n => if n.isEl "a" then n.attr "href" else none

/-- Lowercase ASCII letters and digits only, non-empty, starts with a letter.
Restricting tag and attribute names is what lets the serializer be
unambiguous without parsing. -/
def nameOk (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: cs => c.isLower && cs.all (fun c => c.isLower || c.isDigit || c == '-')

/-- Every element in the tree has a well-formed tag name and well-formed
attribute names. -/
def namesOk (d : Dom) : Bool :=
  (nodes d).all fun n =>
    match n with
    | .text _ => true
    | .el t a _ => nameOk t && a.all (fun p => nameOk p.1)

end Dom

def isWs (c : Char) : Bool := c == ' ' || c == '\n' || c == '\t' || c == '\r'

def trimList (cs : List Char) : List Char :=
  ((cs.dropWhile isWs).reverse.dropWhile isWs).reverse

/-- Whitespace trim, defined on `List Char` so the kernel can evaluate it. -/
@[irreducible] def trimS (s : String) : String := String.ofList (trimList s.toList)

end HnFormal
