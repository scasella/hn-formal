import Lean.Data.Json
import HnFormal
import HnFormal.Check
import HnFormal.Fixtures
/-!
# `hnformal` executable

Trusted base: JSON decoding, tree building, file IO. The renderer and
serializer are the proven parts.
-/
open Lean HnFormal

namespace Decode

def getNat? (j : Json) (k : String) : Option Nat :=
  match j.getObjVal? k with
  | .ok v => match v.getNat? with | .ok n => some n | _ => none
  | _ => none

def getStr? (j : Json) (k : String) : Option String :=
  match j.getObjVal? k with
  | .ok v => match v.getStr? with | .ok s => some s | _ => none
  | _ => none

def getBool (j : Json) (k : String) : Bool :=
  match j.getObjVal? k with
  | .ok v => match v.getBool? with | .ok b => b | _ => false
  | _ => false

def getNats (j : Json) (k : String) : List Nat :=
  match j.getObjVal? k with
  | .ok v => match v.getArr? with
    | .ok arr => arr.toList.filterMap fun x => match x.getNat? with | .ok n => some n | _ => none
    | _ => []
  | _ => []

def item? (j : Json) : Option Item := do
  let id ← getNat? j "id"
  let ty ← (getStr? j "type").bind ItemType.ofString?
  pure { id, type := ty, author := getStr? j "by", time := getNat? j "time", text := getStr? j "text",
         dead := getBool j "dead", deleted := getBool j "deleted", parent := getNat? j "parent",
         kids := getNats j "kids", url := getStr? j "url", score := getNat? j "score",
         title := getStr? j "title", descendants := getNat? j "descendants", parts := getNats j "parts" }

structure Data where
  fetchedAt : Nat
  top : List Nat
  items : Std.HashMap Nat Item

def data? (j : Json) : Except String Data := do
  let fetchedAt ← match getNat? j "fetchedAt" with | some n => pure n | none => throw "missing fetchedAt"
  let top := getNats j "top"
  let itemsJ ← j.getObjVal? "items"
  let obj ← itemsJ.getObj?
  let items := obj.foldl (init := (∅ : Std.HashMap Nat Item)) fun m _ v =>
    match item? v with
    | some it => m.insert it.id it
    | none => m
  pure { fetchedAt, top, items }

/-- Build a comment subtree; absent kids are skipped, cycles are cut by the
visited set, depth is capped. -/
partial def tree (items : Std.HashMap Nat Item) (visited : Std.HashSet Nat) (depth : Nat) (id : Nat) :
    Option CTree × Std.HashSet Nat :=
  if depth = 0 || visited.contains id then (none, visited)
  else match items.get? id with
    | none => (none, visited)
    | some it =>
      if it.type != .comment then (none, visited.insert id) else
      let visited := visited.insert id
      let (kids, visited) := it.kids.foldl (init := ([], visited)) fun (acc, vis) k =>
        match tree items vis (depth - 1) k with
        | (some t, vis') => (acc ++ [t], vis')
        | (none, vis') => (acc, vis')
      (some (.node it kids), visited)

def pages (d : Data) : Page × List (Nat × Page) :=
  let stories := d.top.filterMap fun id => d.items.get? id
  let front : Page := .front { fetchedAt := d.fetchedAt, stories }
  let threads := stories.map fun s =>
    let (comments, _) := s.kids.foldl (init := ([], (∅ : Std.HashSet Nat).insert s.id)) fun (acc, vis) k =>
      match tree d.items vis 500 k with
      | (some t, vis') => (acc ++ [t], vis')
      | (none, vis') => (acc, vis')
    (s.id, Page.thread { fetchedAt := d.fetchedAt, story := s, comments })
  (front, threads)

end Decode

def readData (path : String) : IO Decode.Data := do
  let txt ← IO.FS.readFile path
  match Json.parse txt with
  | .error e => throw (IO.userError s!"bad json: {e}")
  | .ok j => match Decode.data? j with
    | .error e => throw (IO.userError s!"bad data: {e}")
    | .ok d => pure d

def writePage (path : System.FilePath) (p : Page) : IO Unit := do
  if let some parent := path.parent then IO.FS.createDirAll parent
  IO.FS.writeFile path (Html.document (Render.render p))

def cmdRender (dataPath outDir : String) : IO UInt32 := do
  let d ← readData dataPath
  let (front, threads) := Decode.pages d
  writePage (outDir / "index.html") front
  for (id, t) in threads do
    writePage (outDir / "item" / s!"{id}.html") t
  IO.println s!"rendered index + {threads.length} threads to {outDir}"
  pure 0

def checkPage (name : String) (p : Page) : IO Bool := do
  let d := Render.render p
  match Check.firstFailure p d with
  | none => IO.println s!"ok   {name}"; pure true
  | some f => IO.println s!"FAIL {name}: {f}"; pure false

def cmdCheck (dataPath : String) : IO UInt32 := do
  let d ← readData dataPath
  let (front, threads) := Decode.pages d
  let mut ok ← checkPage "index" front
  for (id, t) in threads do
    ok := (← checkPage s!"item/{id}" t) && ok
  pure (if ok then 0 else 1)

def cmdSelftest : IO UInt32 := do
  let mut ok := true
  for (name, p) in Fixtures.all do
    ok := (← checkPage name p) && ok
    let html := Html.document (Render.render p)
    if (html.splitOn "<script").length > 1 then
      IO.println s!"FAIL {name}: script tag in output"; ok := false
    if (html.splitOn "onerror").length > 1 then
      IO.println s!"FAIL {name}: onerror in output"; ok := false
    if (html.splitOn "javascript:").length > 1 then
      IO.println s!"FAIL {name}: javascript: href in output"; ok := false
  -- a quick look at the first fixture for humans
  pure (if ok then 0 else 1)

def main (args : List String) : IO UInt32 := do
  match args with
  | ["render", data, out] => cmdRender data out
  | ["check", data] => cmdCheck data
  | ["selftest"] => cmdSelftest
  | _ =>
    IO.eprintln "usage: hnformal render <data.json> <outdir> | check <data.json> | selftest"
    pure 2
