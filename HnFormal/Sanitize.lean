import HnFormal.Dom
/-!
# Verified allowlist parser for HN comment HTML

The API returns `text` and `title` as HTML. This module parses that HTML into
`Frag`, a type whose constructors *are* the allowlist, and renders `Frag`
back to `Dom`. The theorem `toDom_ok` states that every node the renderer
emits is a text node or one of `p br i a code pre`, and that every `a`
carries only a safe `href` (http, https, mailto) plus `rel=nofollow`.
Unknown tags are dropped (their text is kept); unsafe hrefs are dropped.
-/
namespace HnFormal
namespace Sanitize

inductive Frag
  | text (s : String)
  | br
  | i (cs : List Frag)
  | a (href : String) (cs : List Frag)
  | code (cs : List Frag)
  | pre (cs : List Frag)
  deriving Repr, Inhabited

/-- Safe link schemes. -/
def hrefOk (h : String) : Bool :=
  h.startsWith "http://" || h.startsWith "https://" || h.startsWith "mailto:"

mutual
def Frag.toDom : Frag → Dom
  | .text s => .text s
  | .br => .el "br" [] []
  | .i cs => .el "i" [] (Frag.toDomList cs)
  | .a h cs =>
    let ds := Frag.toDomList cs
    if hrefOk h then
      if (trimS (Dom.concat (Dom.textsList ds))).isEmpty then
        .el "a" [("href", h), ("rel", "nofollow")] [.text "link"]
      else .el "a" [("href", h), ("rel", "nofollow")] ds
    else .el "span" [] ds
  | .code cs => .el "code" [] (Frag.toDomList cs)
  | .pre cs => .el "pre" [] (Frag.toDomList cs)
def Frag.toDomList : List Frag → List Dom
  | [] => []
  | f :: fs => Frag.toDom f :: Frag.toDomList fs
end

/-- One paragraph: runs of inline fragments become `p` elements and `pre`
fragments are emitted at block level (a `pre` inside `p` is invalid HTML). -/
def flush (acc : List Frag) : List Dom :=
  if acc.isEmpty then [] else [.el "p" [] (Frag.toDomList acc)]

def para (acc : List Frag) : List Frag → List Dom
  | [] => flush acc
  | .pre cs :: rest => flush acc ++ Frag.toDom (.pre cs) :: para [] rest
  | f :: rest => para (acc ++ [f]) rest

def toDom (paras : List (List Frag)) : List Dom :=
  paras.flatMap (para [])

/-! What `toDom_ok` guarantees about each emitted node: an allowlisted tag,
no attributes except a safe `href`+`rel` on anchors, and every anchor has
non-blank text. -/

def tagOk (t : String) : Bool :=
  t == "p" || t == "br" || t == "i" || t == "code" || t == "pre" || t == "span" || t == "a"

def attrsOk (t : String) (a : List (String × String)) : Bool :=
  if t == "a" then
    (match a with
     | [("href", h), ("rel", "nofollow")] => hrefOk h
     | _ => false)
  else a.isEmpty

def namedOk (t : String) (cs : List Dom) : Bool :=
  !(t == "a") || !(trimS (Dom.concat (Dom.textsList cs))).isEmpty

def nodeOk : Dom → Bool
  | .text _ => true
  | .el t a cs => tagOk t && attrsOk t a && namedOk t cs

mutual
theorem Frag.toDom_ok : ∀ f : Frag, ∀ n ∈ (Frag.toDom f).nodes, nodeOk n = true
  | .text s => by simp [Frag.toDom, Dom.nodes, nodeOk]
  | .br => by simp [Frag.toDom, Dom.nodes, Dom.nodesList, nodeOk, tagOk, attrsOk, namedOk]
  | .i cs => by
    intro n hn
    simp only [Frag.toDom, Dom.nodes, List.mem_cons] at hn
    rcases hn with rfl | hn
    · simp [nodeOk, tagOk, attrsOk, namedOk]
    · exact Frag.toDomList_ok cs n hn
  | .a h cs => by
    intro n hn
    simp only [Frag.toDom] at hn
    split at hn
    · split at hn
      · simp only [Dom.nodes, Dom.nodesList, List.append_nil, List.mem_cons, List.not_mem_nil, or_false] at hn
        rcases hn with rfl | rfl
        · simp [nodeOk, tagOk, attrsOk, namedOk, *]; decide +kernel
        · simp [nodeOk]
      · simp only [Dom.nodes, List.mem_cons] at hn
        rcases hn with rfl | hn
        · simp [nodeOk, tagOk, attrsOk, namedOk, *]
        · exact Frag.toDomList_ok cs n hn
    · simp only [Dom.nodes, List.mem_cons] at hn
      rcases hn with rfl | hn
      · simp [nodeOk, tagOk, attrsOk, namedOk]
      · exact Frag.toDomList_ok cs n hn
  | .code cs => by
    intro n hn
    simp only [Frag.toDom, Dom.nodes, List.mem_cons] at hn
    rcases hn with rfl | hn
    · simp [nodeOk, tagOk, attrsOk, namedOk]
    · exact Frag.toDomList_ok cs n hn
  | .pre cs => by
    intro n hn
    simp only [Frag.toDom, Dom.nodes, List.mem_cons] at hn
    rcases hn with rfl | hn
    · simp [nodeOk, tagOk, attrsOk, namedOk]
    · exact Frag.toDomList_ok cs n hn
theorem Frag.toDomList_ok : ∀ fs : List Frag, ∀ n ∈ Dom.nodesList (Frag.toDomList fs), nodeOk n = true
  | [] => by simp [Frag.toDomList, Dom.nodesList]
  | f :: fs => by
    intro n hn
    simp only [Frag.toDomList, Dom.nodesList, List.mem_append] at hn
    rcases hn with hn | hn
    · exact Frag.toDom_ok f n hn
    · exact Frag.toDomList_ok fs n hn
end

theorem flush_ok (acc : List Frag) : ∀ n ∈ Dom.nodesList (flush acc), nodeOk n = true := by
  unfold flush
  split
  · simp [Dom.nodesList]
  · intro n hn
    simp only [Dom.nodesList, Dom.nodes, List.append_nil, List.mem_cons] at hn
    rcases hn with rfl | hn
    · simp [nodeOk, tagOk, attrsOk, namedOk]
    · exact Frag.toDomList_ok acc n hn

theorem nodesList_append (xs ys : List Dom) :
    Dom.nodesList (xs ++ ys) = Dom.nodesList xs ++ Dom.nodesList ys := by
  induction xs with
  | nil => simp [Dom.nodesList]
  | cons x xs ih => simp [Dom.nodesList, ih]

theorem para_ok : ∀ (fs acc : List Frag), ∀ n ∈ Dom.nodesList (para acc fs), nodeOk n = true
  | [], acc => by simpa [para] using flush_ok acc
  | .pre cs :: rest, acc => by
    intro n hn
    simp only [para, nodesList_append, Dom.nodesList, List.mem_append] at hn
    rcases hn with hn | hn
    · exact flush_ok acc n hn
    · rcases hn with hn | hn
      · exact Frag.toDom_ok (.pre cs) n hn
      · exact para_ok rest [] n hn
  | .text s :: rest, acc => by intro n hn; exact para_ok rest (acc ++ [.text s]) n hn
  | .br :: rest, acc => by intro n hn; exact para_ok rest (acc ++ [.br]) n hn
  | .i cs :: rest, acc => by intro n hn; exact para_ok rest (acc ++ [.i cs]) n hn
  | .a h cs :: rest, acc => by intro n hn; exact para_ok rest (acc ++ [.a h cs]) n hn
  | .code cs :: rest, acc => by intro n hn; exact para_ok rest (acc ++ [.code cs]) n hn

/-- Every node of a sanitized body is allowlisted. -/
theorem toDom_ok (paras : List (List Frag)) :
    ∀ n ∈ Dom.nodesList (toDom paras), nodeOk n = true := by
  induction paras with
  | nil => simp [toDom, Dom.nodesList]
  | cons p ps ih =>
    intro n hn
    simp only [toDom, List.flatMap_cons, nodesList_append, List.mem_append] at hn
    rcases hn with hn | hn
    · exact para_ok p [] n hn
    · exact ih n (by simpa [toDom] using hn)

/-! ## Entities -/

def hexVal (c : Char) : Option Nat :=
  if c.isDigit then some (c.toNat - '0'.toNat)
  else if 'a' ≤ c && c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
  else if 'A' ≤ c && c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
  else none

def digitsVal (base : Nat) (cs : List Char) : Option Nat :=
  cs.foldlM (fun acc c => do
    let v ← hexVal c
    if v < base then some (acc * base + v) else none) 0

/-- Decode one entity body (between `&` and `;`). -/
def entity (body : List Char) : Option (List Char) :=
  match body with
  | ['a','m','p'] => some ['&']
  | ['l','t'] => some ['<']
  | ['g','t'] => some ['>']
  | ['q','u','o','t'] => some ['"']
  | ['a','p','o','s'] => some ['\'']
  | ['n','b','s','p'] => some [' ']
  | '#' :: 'x' :: ds => (digitsVal 16 ds).bind fun n => if n.isValidChar && n ≠ 0 then some [Char.ofNat n] else none
  | '#' :: 'X' :: ds => (digitsVal 16 ds).bind fun n => if n.isValidChar && n ≠ 0 then some [Char.ofNat n] else none
  | '#' :: ds => (digitsVal 10 ds).bind fun n => if n.isValidChar && n ≠ 0 then some [Char.ofNat n] else none
  | _ => none

/-- Decode entities in a run of text. Unknown or malformed entities are kept
literally. Fuel is the input length. -/
def decodeEntitiesF : Nat → List Char → List Char
  | 0, cs => cs
  | _, [] => []
  | fuel + 1, '&' :: rest =>
    let body := rest.takeWhile (· ≠ ';')
    let after := rest.drop body.length
    if body.length ≤ 10 then
      match after with
      | ';' :: tl =>
        match entity body with
        | some out => out ++ decodeEntitiesF fuel tl
        | none => '&' :: decodeEntitiesF fuel rest
      | _ => '&' :: decodeEntitiesF fuel rest
    else '&' :: decodeEntitiesF fuel rest
  | fuel + 1, c :: rest => c :: decodeEntitiesF fuel rest

def decodeEntities (cs : List Char) : List Char := decodeEntitiesF (cs.length + 1) cs

/-! ## Tokenizer -/

inductive Tok
  | text (s : String)
  | open_ (name : String) (href : Option String)
  | close (name : String)
  | para
  | br
  deriving Repr, Inhabited

/-- Lowercase ASCII name at the start of a tag body. -/
def tagName (cs : List Char) : List Char × List Char :=
  let n := cs.takeWhile fun c => c.isAlpha || c.isDigit
  (n.map Char.toLower, cs.drop n.length)

/-! ### Href encoding

Validators reject characters that are not URL code points (`[`, `]`, `{`,
`}`, `|`, `\`, `^`, `` ` ``, `"`, `<`, `>`, space, control characters) and
stray `%`. Percent-encoding them keeps the link's meaning and makes every
emitted href valid. Non-ASCII characters are URL code points and are kept. -/

def urlCodePoint (c : Char) : Bool :=
  c.isAlphanum || "!$&'()*+,-./:;=?@_~#".toList.contains c || c.toNat ≥ 0x80

def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat ('0'.toNat + n) else Char.ofNat ('A'.toNat + n - 10)

def pct (n : Nat) : List Char := ['%', hexDigit (n / 16 % 16), hexDigit (n % 16)]

def encodeHrefList : List Char → List Char
  | [] => []
  | '%' :: a :: b :: rest =>
    if (hexVal a).isSome && (hexVal b).isSome then '%' :: a :: b :: encodeHrefList rest
    else pct 37 ++ encodeHrefList (a :: b :: rest)
  | c :: rest => (if urlCodePoint c then [c] else pct c.toNat) ++ encodeHrefList rest
termination_by cs => cs.length

@[irreducible] def encodeHref (s : String) : String := String.ofList (encodeHrefList s.toList)

/-- Find `href="..."` or `href='...'` in a tag body. -/
def findHrefF : Nat → List Char → Option String
  | 0, _ => none
  | _, [] => none
  | _, 'h' :: 'r' :: 'e' :: 'f' :: rest =>
    let rest := rest.dropWhile (· == ' ')
    match rest with
    | '=' :: rest =>
      let rest := rest.dropWhile (· == ' ')
      match rest with
      | '"' :: rest => some (String.ofList (encodeHrefList (decodeEntities (rest.takeWhile (· ≠ '"')))))
      | '\'' :: rest => some (String.ofList (encodeHrefList (decodeEntities (rest.takeWhile (· ≠ '\'')))))
      | _ => none
    | _ => none
  | fuel + 1, _ :: rest => findHrefF fuel rest

def findHref (cs : List Char) : Option String := findHrefF (cs.length + 1) cs

def tagTok (body : List Char) : Option Tok :=
  match body with
  | '/' :: rest =>
    let (n, _) := tagName rest
    match String.ofList n with
    | "i" | "em" | "code" | "pre" | "a" => some (.close (String.ofList n))
    | _ => none
  | _ =>
    let (n, rest) := tagName body
    match String.ofList n with
    | "p" => some .para
    | "br" => some .br
    | "i" => some (.open_ "i" none)
    | "em" => some (.open_ "i" none)
    | "code" => some (.open_ "code" none)
    | "pre" => some (.open_ "pre" none)
    | "a" => some (.open_ "a" (findHref rest))
    | _ => none

/-- Tokenize. Unknown tags vanish; a `<` that does not close is literal. -/
def tokenizeF : Nat → List Char → List Tok
  | 0, _ => []
  | _, [] => []
  | fuel + 1, '<' :: rest =>
    let body := rest.takeWhile (· ≠ '>')
    let after := rest.drop body.length
    match after with
    | '>' :: tl =>
      match tagTok body with
      | some t => t :: tokenizeF fuel tl
      | none => tokenizeF fuel tl
    | _ => .text "<" :: tokenizeF fuel rest
  | fuel + 1, c :: rest =>
    let run := (c :: rest).takeWhile (· ≠ '<')
    let rest' := (c :: rest).drop run.length
    .text (String.ofList (decodeEntities run)) :: tokenizeF fuel rest'

def tokenize (cs : List Char) : List Tok := tokenizeF (cs.length + 1) cs

/-! ## Tree builder -/

/-- Parse tokens into fragments until a close tag or end. Returns the
fragments and the remaining tokens (after the close tag). Fuel = token count. -/
def build (fuel : Nat) : List Tok → List Frag × List Tok
  | [] => ([], [])
  | t :: ts =>
    match fuel with
    | 0 => ([], [])
    | fuel + 1 =>
      match t with
      | .text s => let (fs, rest) := build fuel ts; (.text s :: fs, rest)
      | .br => let (fs, rest) := build fuel ts; (.br :: fs, rest)
      | .para => ([], t :: ts)  -- paragraph break ends this run; caller handles
      | .close _ => ([], ts)
      | .open_ name href =>
        let (kids, rest) := build fuel ts
        let (fs, rest') := build fuel rest
        let node := match name with
          | "a" => Frag.a (href.getD "") kids
          | "code" => Frag.code kids
          | "pre" => Frag.pre kids
          | _ => Frag.i kids
        (node :: fs, rest')

/-- Split into paragraphs at `para` tokens and build each. -/
def paragraphs (fuel : Nat) : List Tok → List (List Frag)
  | [] => []
  | toks =>
    match fuel with
    | 0 => []
    | fuel + 1 =>
      let toks := toks.dropWhile (fun t => match t with | .para => true | _ => false)
      let (fs, rest) := build toks.length toks
      -- `build` stops at a para token or when it runs out; a stray close tag
      -- returns remaining tokens which we keep consuming.
      let rest := match rest with
        | .para :: tl => tl
        | r => r
      if toks.isEmpty then []
      else if rest.length < toks.length then fs :: paragraphs fuel rest
      else [fs]

/-- Sanitize a comment/story body into paragraphs. -/
def parse (html : String) : List (List Frag) :=
  let toks := tokenize html.toList
  (paragraphs (toks.length + 1) toks).filter (fun p => !p.isEmpty)

/-- Entity-decoded, tag-stripped plain text (for titles). -/
def plain (html : String) : String :=
  String.join ((tokenize html.toList).filterMap fun t =>
    match t with | .text s => some s | _ => none)

/-- The sanitized DOM of a body. Irreducible: proofs go through the lemmas
in `Lemmas.lean`, never by unfolding the parser. -/
@[irreducible] def body (html : String) : List Dom := toDom (parse html)

end Sanitize
end HnFormal
