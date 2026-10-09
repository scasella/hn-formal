#!/usr/bin/env bash
# path-guard.sh <base-sha> <head-sha>
#
# Exit 1 if the diff base..head touches any path other than the LLM-editable
# and record paths (CONTRACT.md "The only paths a candidate may change"):
#   HnFormal/Render.lean   site/style.css   releases/**   runs/**   data/**
#   README.md (its generation section is rewritten by the release step)
# unless the head commit's message contains "[human]".
#
# Used by ci.yml on pushes to main by github-actions[bot], and by redesign.yml
# on the release commit before it is pushed. Needs full history (checkout
# with fetch-depth: 0). A base of all zeros (branch creation / force push) is
# replaced by head's first parent.
set -u
base="${1:-}"; head="${2:-}"
if [ -z "$base" ] || [ -z "$head" ]; then
  echo "path-guard: usage: path-guard.sh <base-sha> <head-sha>"
  exit 2
fi
case "$base" in
  0000000000000000000000000000000000000000|"") base="${head}~1" ;;
esac

msg="$(git log -1 --format=%B "$head" 2>/dev/null)" || { echo "path-guard: cannot read commit $head"; exit 2; }
if printf '%s' "$msg" | grep -qF '[human]'; then
  echo "path-guard: OK: head commit is tagged [human]; skipping path check"
  exit 0
fi

if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "path-guard: base $base is not a commit (shallow clone? use fetch-depth: 0)"
  exit 2
fi

changed="$(git diff --name-only "$base" "$head")"
bad="$(printf '%s\n' "$changed" | grep -v -E '^(HnFormal/Render\.lean|site/style\.css|README\.md|releases/.+|runs/.+|data/.+)$' | grep -v '^$' || true)"
if [ -n "$bad" ]; then
  echo "path-guard: FAIL: diff $base..$head touches paths outside the allowed set:"
  printf '  %s\n' $bad
  exit 1
fi
echo "path-guard: OK: $(printf '%s\n' "$changed" | grep -c . ) changed path(s) all within the allowed set"
exit 0
