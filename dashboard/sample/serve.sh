#!/usr/bin/env bash
# Serve the dashboard locally with the sample JSON, laid out the way
# build-site.sh lays out the real site (dashboard at /loop/, data files at
# /loop/releases.json and /loop/runs.json). Screenshots are absent, so the
# cards show "screenshot missing", which is the intended fallback.
#
#   dashboard/sample/serve.sh [port]      then open http://localhost:8765/loop/
set -euo pipefail
port="${1:-8765}"
here="$(cd "$(dirname "$0")" && pwd)"
dash="$(dirname "$here")"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/loop"
cp "$dash/index.html" "$dash/loop.css" "$dash/loop.js" "$root/loop/"
cp "$here/releases.json" "$here/runs.json" "$root/loop/"
printf '<!DOCTYPE html><meta charset="utf-8"><title>stub</title><p>Site root stub; the dashboard is at <a href="/loop/">/loop/</a>.</p>\n' > "$root/index.html"
echo "serving $root at http://localhost:$port/loop/  (ctrl-c to stop)"
cd "$root"
exec python3 -m http.server "$port" --bind 127.0.0.1
