#!/usr/bin/env bash
# Exit 0 if a Lean toolchain is installed under ~/.elan and actually runs.
#
# Calls each toolchain's own `lean` directly, not the elan proxy in
# ~/.elan/bin, because the proxy would try to download a missing toolchain and
# so hide the very failure we are testing for. A half-extracted toolchain
# (truncated archive) fails the `--version` call and counts as not installed.
set -u
shopt -s nullglob
for lean in "${ELAN_HOME:-$HOME/.elan}"/toolchains/*/bin/lean; do
  if "$lean" --version >/dev/null 2>&1; then
    exit 0
  fi
done
exit 1
