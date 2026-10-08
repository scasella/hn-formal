#!/bin/sh
# Fake `hnformal` binary for orchestrator tests (no Lean toolchain needed).
#   selftest            -> exit 0
#   check <data>        -> prints ok
#   render <data> <out> -> copies the fixture site into <out> (html only; the
#                          orchestrator copies style.css/fonts itself)
set -e
here=$(cd "$(dirname "$0")" && pwd)
case "$1" in
  selftest) echo "selftest ok (fake)"; exit 0 ;;
  check) echo ok; exit 0 ;;
  render)
    data=$2; out=$3
    [ -f "$data" ] || { echo "no data file: $data" >&2; exit 2; }
    mkdir -p "$out/item"
    cp "$here/fixture-site/index.html" "$out/index.html"
    cp "$here/fixture-site/item/"*.html "$out/item/"
    echo "rendered fixture into $out (fake)"
    ;;
  *) echo "usage: hnformal render|check|selftest" >&2; exit 2 ;;
esac
