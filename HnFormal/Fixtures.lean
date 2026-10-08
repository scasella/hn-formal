import HnFormal.Item
/-!
# Built-in fixtures for `hnformal selftest`

Cover the API's corners: jobs (no author/score/descendants), polls with
`parts`, Ask HN with a text body, missing url, blank title and author,
deleted and dead comments, a deep thread, hostile HTML, entities.
-/
namespace HnFormal
namespace Fixtures

def now : Nat := 1760000000

def story1 : Item :=
  { id := 1, type := .story, author := some "pg", time := some (now - 3600 * 5),
    title := some "Show HN: A &quot;proven&quot; front page &amp; more <b>bold</b>",
    url := some "https://www.example.com/path?q=1#frag", score := some 123, descendants := some 2,
    kids := [10, 11] }

def job2 : Item :=
  { id := 2, type := .job, time := some (now - 60), title := some "Acme (YC W26) is hiring",
    url := some "https://jobs.example.com/x", descendants := some 3 }

def ask3 : Item :=
  { id := 3, type := .story, author := some "", time := some (now - 86400 * 2),
    title := some "   ", score := some 0, descendants := some 0,
    text := some "Ask HN: <i>why</i>?<p>Second <a href=\"javascript:alert(1)\">bad</a> <a href=\"https://ok.example\"></a> para<p><pre><code>x &lt; y\n</code></pre>" }

def poll4 : Item :=
  { id := 4, type := .poll, author := some "voter", time := some now, title := some "Poll?",
    score := some 7, descendants := some 0, parts := [40, 41] }

def c10 : Item :=
  { id := 10, type := .comment, author := some "alice", time := some (now - 100), parent := some 1,
    text := some "First &#x27;comment&#x27; <script>alert(1)</script> &amp; <img src=x onerror=alert(1)>",
    kids := [12] }

def c11 : Item :=
  { id := 11, type := .comment, deleted := true, parent := some 1, kids := [] }

def c12 : Item :=
  { id := 12, type := .comment, author := some "bob", time := some (now - 50), parent := some 10,
    dead := true, text := some "dead reply" }

def deepItem (id : Nat) (txt : String) : Item :=
  { id := id, type := .comment, author := some "d", time := some now, text := some txt }

/-- A chain of `n` nested comments. -/
def deep : Nat → Nat → CTree
  | 0, id => .node (deepItem id "leaf") []
  | n + 1, id => .node (deepItem id ("depth " ++ toString n)) [deep n (id + 1)]

def front : Page := .front { fetchedAt := now, stories := [story1, job2, ask3, poll4, story1] }

def thread1Comments : List CTree := [.node c10 [.node c12 []], .node c11 []]

def thread1 : Page := .thread { fetchedAt := now, story := story1, comments := thread1Comments }

def thread3 : Page := .thread { fetchedAt := now, story := ask3, comments := [] }

def threadDeep : Page := .thread { fetchedAt := now, story := job2, comments := [deep 60 1000] }

def emptyFront : Page := .front { fetchedAt := now, stories := [] }

def all : List (String × Page) :=
  [("front", front), ("thread1", thread1), ("thread3", thread3), ("threadDeep", threadDeep),
   ("emptyFront", emptyFront)]

end Fixtures
end HnFormal
