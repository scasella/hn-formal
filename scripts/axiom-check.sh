#!/usr/bin/env bash
# axiom-check.sh
#
# Tier-1 gate (CONTRACT.md, candidate protocol step 4). Runs
#   lake env lean scripts/Axioms.lean
# from the repo root and exits 1 unless the axioms that
# HnFormal.Render.render_ok depends on are a subset of
#   { propext, Classical.choice, Quot.sound }.
#
# Assumes `lake build` has already succeeded (the .olean for HnFormal.Render
# must exist; `lake env lean` does not build dependencies).
#
# Lean 4 prints one of:
#   'HnFormal.Render.render_ok' depends on axioms: [propext, Classical.choice, Quot.sound]
#   'HnFormal.Render.render_ok' does not depend on any axioms
# Both are parsed. Anything else (including a missing declaration, which makes
# lean exit non-zero) is a failure.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 1

decl='HnFormal.Render.render_ok'
allowed=' propext Classical.choice Quot.sound '

out="$(lake env lean scripts/Axioms.lean 2>&1)"; rc=$?
printf '%s\n' "$out"
if [ "$rc" -ne 0 ]; then
  echo "axiom-check: FAIL: lean exited with status $rc"
  exit 1
fi

line="$(printf '%s\n' "$out" | grep -F "'$decl'" | head -n 1)"
if [ -z "$line" ]; then
  echo "axiom-check: FAIL: no '#print axioms' line for $decl in output"
  exit 1
fi

if printf '%s' "$line" | grep -q 'does not depend on any axioms'; then
  echo "axiom-check: OK: $decl depends on no axioms"
  exit 0
fi

list="$(printf '%s' "$line" | sed -n 's/.*depends on axioms: \[\(.*\)\].*/\1/p')"
if [ -z "$list" ] && ! printf '%s' "$line" | grep -q 'depends on axioms: \[\]'; then
  echo "axiom-check: FAIL: could not parse axiom list from: $line"
  exit 1
fi

bad=""
old_ifs="$IFS"; IFS=','
for ax in $list; do
  ax="$(printf '%s' "$ax" | tr -d '[:space:]')"
  [ -z "$ax" ] && continue
  case "$allowed" in
    *" $ax "*) ;;
    *) bad="$bad $ax" ;;
  esac
done
IFS="$old_ifs"

if [ -n "$bad" ]; then
  echo "axiom-check: FAIL: $decl depends on disallowed axiom(s):$bad"
  exit 1
fi
echo "axiom-check: OK: $decl axioms [$list] are within {propext, Classical.choice, Quot.sound}"
exit 0
