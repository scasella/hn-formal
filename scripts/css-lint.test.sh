#!/usr/bin/env bash
# Fixture tests for css-lint.sh. Run from anywhere: scripts/css-lint.test.sh
# Each fixture is written to a temp dir; "pass" fixtures must exit 0 and
# "fail" fixtures must exit 1 with a non-empty one-line reason on stdout.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
lint="$here/css-lint.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
total=0

expect() { # expect pass|fail <name> <css>
  local want="$1" name="$2" css="$3" f out rc
  total=$((total + 1))
  f="$tmp/$name.css"
  printf '%s\n' "$css" > "$f"
  out="$("$lint" "$f")"; rc=$?
  if [ "$want" = pass ] && [ "$rc" -eq 0 ]; then
    echo "ok   pass $name"
  elif [ "$want" = fail ] && [ "$rc" -eq 1 ] && [ -n "$out" ] && [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -eq 1 ]; then
    echo "ok   fail $name  -> $out"
  else
    echo "FAIL $name: wanted $want, got rc=$rc out='$out'"
    failures=$((failures + 1))
  fi
}

# ---- passing fixtures -------------------------------------------------------
expect pass plain 'body { margin: 0; color: #111; font: 16px/1.4 system-ui, sans-serif; }'
expect pass empty_file ''
expect pass content_empty_dq 'a::after { content: ""; }'
expect pass content_empty_sq "a::after { content: ''; }"
expect pass content_none 'li::marker { content: none; }'
expect pass content_normal 'q::before { content: normal; }'
expect pass content_counter 'li::before { content: counter(item) ; }'
expect pass content_counters 'li::before { content: counters(item, ".") }'
expect pass content_attr 'a::after { content: attr(href); }'
expect pass content_escaped_glyph 'q::before { content: "\201C"; }'
expect pass content_escaped_with_space 'q::before { content: "\2014 "; }'
expect pass content_two_escapes "q::before { content: '\\201C\\201D'; }"
expect pass content_escape_and_attr 'li::before { content: "\2022 " attr(data-n); }'
expect pass content_nospace 'li::before{content:"";}'
expect pass content_uppercase 'li::before { CONTENT: NONE; }'
expect pass content_multiline 'li::before {
  content:
    "";
}'
expect pass url_fonts_bare '@font-face { font-family: X; src: url(/fonts/x.woff2) format("woff2"); }'
expect pass url_fonts_dq '@font-face { src: url("/fonts/x.woff2"); }'
expect pass url_fonts_sq "@font-face { src: url( '/fonts/x.woff2' ); }"
expect pass comment_with_import '/* @import "evil.css"; content: "hi"; url(https://x) */ body { margin: 0 }'
expect pass comment_multiline '/* line one
@import url(https://evil);
*/ body { margin: 0 }'
expect pass word_content_in_selector '.content { padding: 1rem } .main-content > p { margin: 0 }'
expect pass unterminated_comment_hides_rest 'body { margin: 0 } /* @import "x";'

# ---- failing fixtures -------------------------------------------------------
expect fail import_plain '@import "other.css";'
expect fail import_url '@import url(/fonts/x.css);'
expect fail import_upper '@IMPORT "x.css";'
expect fail content_word 'a::after { content: "hello"; }'
expect fail content_single_letter 'a::after { content: "a"; }'
expect fail content_digit 'a::after { content: "1"; }'
expect fail content_unquoted_word 'a::after { content: hello; }'
expect fail content_open_quote 'q::before { content: open-quote; }'
expect fail content_escape_plus_letter 'q::before { content: "\201C" "x"; }'
expect fail content_escape_then_letters 'q::before { content: "\201Cfoo"; }'
expect fail content_url 'a::after { content: url(/fonts/x.png); }'
expect fail content_empty_unquoted 'a::after { content: ; }'
expect fail content_counter_then_word 'li::before { content: counter(item) "pts"; }'
expect fail content_unbalanced_quote 'li::before { content: "; }'
expect fail url_https '.x { background: url(https://example.com/a.png); }'
expect fail url_data '.x { background: url(data:image/png;base64,AAAA); }'
expect fail url_relative '.x { background: url(a.png); }'
expect fail url_root_not_fonts '.x { background: url(/images/a.png); }'
expect fail url_fonts_traversal '@font-face { src: url(/fonts/../x.woff2); }'
expect fail url_fonts_prefix_trick '@font-face { src: url(/fontsx/x.woff2); }'
expect fail url_uppercase '.x { background: URL(HTTPS://EXAMPLE.COM/A.PNG); }'
expect fail url_unterminated '.x { background: url(/fonts/x.woff2 ; }'
expect fail expression '.x { width: expression(document.body.clientWidth); }'
expect fail behavior '.x { behavior: url(/fonts/x.htc); }'
expect fail moz_binding '.x { -moz-binding: url(/fonts/x.xml#y); }'
expect fail escape_outside_content '.x { background: \75rl(https://evil); }'
expect fail missing_file_arg_handled_elsewhere '@import "x";'

# missing file / no argument
total=$((total + 1))
if out="$("$lint" "$tmp/does-not-exist.css")"; then
  echo "FAIL missing_file: expected exit 1"; failures=$((failures + 1))
else
  echo "ok   fail missing_file  -> $out"
fi

echo
echo "$((total - failures))/$total fixtures behaved as expected"
[ "$failures" -eq 0 ]
