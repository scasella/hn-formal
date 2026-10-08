import HnFormal.Dom
/-!
# Serializer

`Dom → String`, with proofs that escaped text and attribute values contain
no `<` and no `"`, so the serialized bytes encode exactly the tree.
Strings are handled as `List Char` so that proofs are by list induction.
-/
namespace HnFormal
namespace Html

def escapeChar (c : Char) : List Char :=
  if c == '<' then "&lt;".toList
  else if c == '>' then "&gt;".toList
  else if c == '&' then "&amp;".toList
  else if c == '"' then "&quot;".toList
  else if c == '\'' then "&#39;".toList
  else [c]

def escapeList : List Char → List Char
  | [] => []
  | c :: cs => escapeChar c ++ escapeList cs

def escape (s : String) : String := String.ofList (escapeList s.toList)

theorem escapeChar_no_lt (c : Char) : '<' ∉ escapeChar c := by
  unfold escapeChar
  repeat' split
  all_goals first
    | decide
    | (rename_i h1 h2 h3 h4 h5; simp only [List.mem_singleton]; intro h; subst h; simp at h1)

theorem escapeChar_no_quote (c : Char) : '"' ∉ escapeChar c := by
  unfold escapeChar
  repeat' split
  all_goals first
    | decide
    | (rename_i h1 h2 h3 h4 h5; simp only [List.mem_singleton]; intro h; subst h; simp at h4)

theorem escapeList_no_lt (cs : List Char) : '<' ∉ escapeList cs := by
  induction cs with
  | nil => simp [escapeList]
  | cons c cs ih =>
    simp only [escapeList, List.mem_append, not_or]
    exact ⟨escapeChar_no_lt c, ih⟩

theorem escapeList_no_quote (cs : List Char) : '"' ∉ escapeList cs := by
  induction cs with
  | nil => simp [escapeList]
  | cons c cs ih =>
    simp only [escapeList, List.mem_append, not_or]
    exact ⟨escapeChar_no_quote c, ih⟩

/-- The two serializer guarantees, stated on strings. -/
theorem escape_no_lt (s : String) : '<' ∉ (escape s).toList := by
  simp only [escape, String.toList_ofList]; exact escapeList_no_lt _

theorem escape_no_quote (s : String) : '"' ∉ (escape s).toList := by
  simp only [escape, String.toList_ofList]; exact escapeList_no_quote _

def voidTags : List String := ["br", "meta", "link", "hr", "img", "input", "wbr"]

def attrsToString (a : List (String × String)) : String :=
  String.join (a.map fun (k, v) => " " ++ k ++ "=\"" ++ escape v ++ "\"")

mutual
def render : Dom → String
  | .text s => escape s
  | .el t a cs =>
    if voidTags.contains t then "<" ++ t ++ attrsToString a ++ ">"
    else "<" ++ t ++ attrsToString a ++ ">" ++ renderList cs ++ "</" ++ t ++ ">"
def renderList : List Dom → String
  | [] => ""
  | d :: ds => render d ++ renderList ds
end

def document (d : Dom) : String := "<!doctype html>\n" ++ render d ++ "\n"

end Html
end HnFormal
