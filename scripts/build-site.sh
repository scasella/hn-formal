#!/usr/bin/env bash
# build-site.sh <data.json> <outdir>
#
# Builds the whole GitHub Pages tree (CONTRACT.md "Site layout on Pages"):
#   /index.html /item/<id>.html   rendered by the proven Lean binary
#   /style.css /fonts/*           copied from site/
#   /loop/*                       the fixed dashboard (dashboard/, minus sample/)
#   /loop/releases.json           copy of releases/index.json  ([] if missing)
#   /loop/runs.json               copy of runs/index.json      ([] if missing)
#   /loop/releases/<id>/*.png     each release's screenshots
#   /spec/Spec.lean               copy of HnFormal/Spec.lean
#   /feed.xml /sitemap.xml        written by `cli site-extras` from releases/index.json
#   /preview.png                  the current release's social-card screenshot
#                                 (Spec.previewHref; og:image on every page)
#
# Content-Security-Policy: GitHub Pages cannot send response headers (no
# `_headers` support), so the policy is delivered as a <meta http-equiv>
# tag instead. For every Lean-rendered page (index.html, item/*.html) this
# script inserts
#   <meta http-equiv="Content-Security-Policy"
#         content="default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'">
# right after the opening <head> tag, but ONLY if the page does not already
# contain a Content-Security-Policy meta (the renderer may emit its own; grep
# first, never duplicate). The dashboard under /loop/ ships its own, slightly
# wider, meta CSP in dashboard/index.html (it needs script-src and
# connect-src 'self' to load loop.js and the two JSON files); this script does
# not touch dashboard files. Note a meta CSP cannot express frame-ancestors or
# report-uri; everything else in the policy works.
set -euo pipefail
data="${1:-}"; out="${2:-}"
if [ -z "$data" ] || [ -z "$out" ]; then
  echo "usage: build-site.sh <data.json> <outdir>" >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f "$data" ] || { echo "build-site: data file not found: $data" >&2; exit 2; }

CSP_META='<meta http-equiv="Content-Security-Policy" content="default-src '"'"'none'"'"'; style-src '"'"'self'"'"'; font-src '"'"'self'"'"'; img-src '"'"'self'"'"'">'

echo "build-site: lake build"
lake build
rm -rf "$out"
mkdir -p "$out"
echo "build-site: hnformal render $data $out"
lake exe hnformal render "$data" "$out"

# --- CSP meta into the Lean-rendered pages (before anything else is copied in)
inject_csp() {
  local f="$1" tmp
  if grep -qi 'http-equiv="Content-Security-Policy"' "$f" || grep -qi "http-equiv='Content-Security-Policy'" "$f"; then
    return 0
  fi
  if ! grep -qi '<head[ >]' "$f"; then
    echo "build-site: WARNING: no <head> in $f; CSP meta not injected" >&2
    return 0
  fi
  tmp="$(mktemp)"
  # Insert after the first opening <head ...> tag (portable: awk, not sed -i).
  awk -v meta="$CSP_META" '
    BEGIN { done = 0 }
    {
      if (!done && match(tolower($0), /<head[^>]*>/)) {
        print substr($0, 1, RSTART + RLENGTH - 1) meta substr($0, RSTART + RLENGTH)
        done = 1
      } else print
    }' "$f" > "$tmp"
  mv "$tmp" "$f"
}
n=0
for f in "$out"/index.html "$out"/item/*.html; do
  [ -f "$f" ] || continue
  inject_csp "$f"; n=$((n + 1))
done
echo "build-site: CSP meta ensured on $n rendered page(s)"

# --- stylesheet and fonts
cp site/style.css "$out/style.css"
if [ -d site/fonts ]; then
  mkdir -p "$out/fonts"
  cp -R site/fonts/. "$out/fonts/"
fi

# --- dashboard
mkdir -p "$out/loop"
for entry in dashboard/*; do
  name="$(basename "$entry")"
  case "$name" in sample|serve.sh) continue ;; esac
  cp -R "$entry" "$out/loop/$name"
done
if [ -f releases/index.json ]; then cp releases/index.json "$out/loop/releases.json"; else echo '[]' > "$out/loop/releases.json"; fi
if [ -f runs/index.json ]; then cp runs/index.json "$out/loop/runs.json"; else echo '[]' > "$out/loop/runs.json"; fi

# --- release screenshots
if [ -d releases ]; then
  for rel in releases/*/; do
    [ -d "$rel" ] || continue
    id="$(basename "$rel")"
    pngs=( "$rel"*.png )
    [ -e "${pngs[0]}" ] || continue
    mkdir -p "$out/loop/releases/$id"
    cp "${pngs[@]}" "$out/loop/releases/$id/"
  done
fi

# --- feed, sitemap, social-card image (orchestrator/src/siteExtras.ts)
if [ -d orchestrator/node_modules ]; then
  npm --prefix orchestrator run --silent cli -- site-extras --out "$out"
else
  echo "build-site: WARNING: orchestrator/node_modules missing; feed.xml, sitemap.xml and preview.png not written" >&2
fi

# --- spec copy
if [ -f HnFormal/Spec.lean ]; then
  mkdir -p "$out/spec"
  cp HnFormal/Spec.lean "$out/spec/Spec.lean"
else
  echo "build-site: WARNING: HnFormal/Spec.lean not found; /spec/ not written" >&2
fi

# Pages is deployed via actions/deploy-pages (no Jekyll), but .nojekyll is
# harmless and keeps the tree usable with the branch-based Pages mode too.
touch "$out/.nojekyll"

echo "build-site: done -> $out"
