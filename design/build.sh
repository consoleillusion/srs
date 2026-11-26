#!/bin/sh
# Compile the design book to dist/srs.pdf. Pass --watch to rebuild on save.
set -eu
cd "$(dirname "$0")"
mkdir -p ../dist

font_path="${SRS_FONT_PATH:-$HOME/.local/share/fonts/srs-brand}"

if command -v typst >/dev/null 2>&1; then
  if [ "${1:-}" = "--watch" ]; then
    exec typst watch --font-path "$font_path" index.typ ../dist/srs.pdf
  fi
  typst compile --font-path "$font_path" index.typ ../dist/srs.pdf
else
  echo "typst is not installed. Install it from https://typst.app/open-source/" >&2
  echo "(or: cargo install typst-cli, brew install typst)." >&2
  exit 1
fi
echo "Wrote $(cd .. && pwd)/dist/srs.pdf"
