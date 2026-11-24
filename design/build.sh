#!/bin/sh
# Compile the design book to design/book.pdf. Pass --watch to rebuild on save.
set -eu
cd "$(dirname "$0")"

if command -v typst >/dev/null 2>&1; then
  if [ "${1:-}" = "--watch" ]; then
    exec typst watch book.typ book.pdf
  fi
  typst compile book.typ book.pdf
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import typst' 2>/dev/null; then
  python3 -c 'import typst; typst.compile("book.typ", output="book.pdf")'
else
  echo "typst is not installed. Install it from https://typst.app/open-source/" >&2
  echo "(or: cargo install typst-cli, brew install typst, pip install typst)." >&2
  exit 1
fi
echo "Wrote $(pwd)/book.pdf"
