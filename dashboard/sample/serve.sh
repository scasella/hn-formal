#!/usr/bin/env bash
# Serve the dashboard locally with the sample JSON, laid out the way
# build-site.sh lays out the real site and GitHub Pages serves it: the site
# under a path prefix (default /hn-formal, like https://scasella.github.io/hn-formal/),
# the dashboard at <prefix>/loop/, data files at <prefix>/loop/releases.json
# and <prefix>/loop/runs.json. Every URL in the dashboard is relative to its
# own document, which is what this layout exercises. Screenshots are absent,
# so the cards show "screenshot missing", which is the intended fallback.
#
#   dashboard/sample/serve.sh [port]      then open http://localhost:8765/hn-formal/loop/
#   SITE_PREFIX= dashboard/sample/serve.sh   serves at the root instead (/loop/)
set -euo pipefail
port="${1:-8765}"
prefix="${SITE_PREFIX-/hn-formal}"
prefix="${prefix#/}"; prefix="${prefix%/}"
here="$(cd "$(dirname "$0")" && pwd)"
dash="$(dirname "$here")"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
site="$root${prefix:+/$prefix}"
mkdir -p "$site/loop"
cp "$dash/index.html" "$dash/loop.css" "$dash/loop.js" "$site/loop/"
cp "$here/releases.json" "$here/runs.json" "$site/loop/"
printf '<!DOCTYPE html><meta charset="utf-8"><title>stub</title><p>Site root stub; the dashboard is at <a href="loop/">loop/</a>.</p>\n' > "$site/index.html"
mkdir -p "$site/spec"
printf -- '-- Spec.lean stub (the real one is copied by build-site.sh)\n' > "$site/spec/Spec.lean"
echo "serving $root at http://localhost:$port/${prefix:+$prefix/}loop/  (ctrl-c to stop)"
cd "$root"
exec python3 -m http.server "$port" --bind 127.0.0.1
