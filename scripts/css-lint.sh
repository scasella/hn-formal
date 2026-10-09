#!/usr/bin/env bash
# css-lint.sh <file.css>
#
# Static guard for the LLM-editable stylesheet (CONTRACT.md, candidate protocol
# step 2). Exit 0 if the file is acceptable; otherwise print ONE line with the
# reason on stdout and exit 1. First failure wins.
#
# Rules (deliberately strict; tier 2 re-checks the computed stylesheet):
#   - no `@import`
#   - every `content:` value must be one of: "" '' none normal, a counter()/
#     counters()/attr() call, or a quoted string whose only non-punctuation
#     characters are backslash escapes (e.g. "\201C", "\2014 "). Any letter or
#     digit outside a `\` escape is rejected, so pseudo-elements cannot inject
#     copy that bypasses the proven DOM.
#   - every `url(` argument must start with `/hn-formal/fonts/` (the site prefix) (optionally quoted) and
#     must not contain `..`
#   - no `expression(`, `behavior:`, `-moz-binding`
#   - no backslash escapes outside `content:` values (an escaped `\75rl(` is
#     `url(` to the browser but not to grep)
#
# Pure bash + grep/sed/awk/tr. Comments are stripped before checking, so a
# comment that mentions @import is fine (the browser ignores it too).

set -u

file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "css-lint: usage: css-lint.sh <file.css> (file not found: '${file}')"
  exit 1
fi

fail() { echo "css-lint: $1"; exit 1; }

# 1. Strip /* ... */ comments (multi-line). An unterminated comment swallows
#    the rest of the file, which is also what a browser does.
#    Output is folded to one line per declaration-ish chunk by replacing
#    newlines with spaces, so multi-line values are handled.
stripped="$(awk '
  BEGIN { inc = 0 }
  {
    line = $0
    out = ""
    while (length(line) > 0) {
      if (inc) {
        e = index(line, "*/")
        if (e == 0) { line = ""; break }
        line = substr(line, e + 2); inc = 0
      } else {
        s = index(line, "/*")
        if (s == 0) { out = out line; line = ""; break }
        out = out substr(line, 1, s - 1)
        line = substr(line, s + 2); inc = 1
      }
    }
    print out
  }' "$file" | tr '\n\r\t' '   ')"

lower="$(printf '%s' "$stripped" | tr '[:upper:]' '[:lower:]')"

# 2. Hard-banned tokens anywhere.
printf '%s' "$lower" | grep -q '@import'     && fail "@import is not allowed"
printf '%s' "$lower" | grep -q 'expression(' && fail "expression( is not allowed"
printf '%s' "$lower" | grep -q 'behavior:'   && fail "behavior: is not allowed"
printf '%s' "$lower" | grep -q -- '-moz-binding' && fail "-moz-binding is not allowed"

# 3. Extract every `content:` declaration value (up to ; or } or EOF).
#    We work on the lowercased, comment-free text.
#    Each extracted value is prefixed with "v:" so an empty value still
#    produces a line (and is then rejected).
content_values="$(printf '%s\n' "$lower" | grep -o 'content[[:space:]]*:[^;}]*' | sed 's/^content[[:space:]]*:[[:space:]]*/v:/; s/[[:space:]]*$//')"

if [ -n "$content_values" ]; then
  while IFS= read -r v; do
    v="${v#v:}"
    [ -z "$v" ] && fail "content: has an empty (unquoted) value"
    # Remove allowed function calls and keywords.
    rest="$(printf '%s' "$v" | sed -E 's/counters?\([^()]*\)//g; s/attr\([^()]*\)//g; s/(^|[[:space:]])(none|normal)([[:space:]]|$)/ /g')"
    # Remove escapes: \ + 1-6 hex digits + optional single space, or \ + one non-hex char.
    rest="$(printf '%s' "$rest" | sed -E 's/\\[0-9a-f]{1,6} ?//g; s/\\[^0-9a-f]//g')"
    # Whatever remains may only be quotes and whitespace.
    if printf '%s' "$rest" | grep -q '[^"'"'"'[:space:]]'; then
      fail "content: value not allowed: '$v' (only \"\", '', none, normal, counter()/attr(), or escaped glyphs)"
    fi
    # Quotes must be balanced-ish: reject a lone quote.
    nq="$(printf '%s' "$rest" | tr -cd '"' | wc -c | tr -d ' ')"
    ns="$(printf '%s' "$rest" | tr -cd "'" | wc -c | tr -d ' ')"
    if [ $((nq % 2)) -ne 0 ] || [ $((ns % 2)) -ne 0 ]; then
      fail "content: value has unbalanced quotes: '$v'"
    fi
  done <<EOV
$content_values
EOV
fi

# 4. Everything outside content: values must contain no backslash escapes.
without_content="$(printf '%s\n' "$lower" | sed -E 's/content[[:space:]]*:[^;}]*//g')"
if printf '%s' "$without_content" | grep -q '\\'; then
  fail "backslash escapes are only allowed inside content: values"
fi

# 5. url( arguments must start with /hn-formal/fonts/ and contain no '..'.
urls="$(printf '%s\n' "$lower" | grep -o 'url([^)]*)' || true)"
if [ -n "$urls" ]; then
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    arg="$(printf '%s' "$u" | sed -E 's/^url\([[:space:]]*//; s/[[:space:]]*\)$//; s/^["'"'"']//; s/["'"'"']$//; s/[[:space:]]*$//')"
    case "$arg" in
      /hn-formal/fonts/*) ;;
      *) fail "url() outside /hn-formal/fonts/ is not allowed: $u" ;;
    esac
    case "$arg" in
      *..*) fail "url() must not contain '..': $u" ;;
    esac
  done <<EOU
$urls
EOU
fi
# A bare `url(` whose closing paren is missing is malformed; reject it.
if printf '%s' "$lower" | grep -o 'url(' >/dev/null; then
  n_open="$(printf '%s' "$lower" | grep -o 'url(' | wc -l | tr -d ' ')"
  n_full="$(printf '%s' "$lower" | grep -o 'url([^)]*)' | wc -l | tr -d ' ')"
  [ "$n_open" -ne "$n_full" ] && fail "malformed url( without closing parenthesis"
fi

exit 0
