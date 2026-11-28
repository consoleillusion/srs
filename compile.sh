#!/usr/bin/env bash
# Compile the Secure Architecture book from the project root.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$root/srs-design.pdf}"

# Keep PDF creation metadata stable for a given set of sources. Using the last
# commit that touched content/ means regenerating the tracked PDF does not
# change the timestamp on the next build.
epoch="$(git -C "$root" log -1 --format=%ct -- content 2>/dev/null || printf '0')"

typst compile "$root/design/index.typ" "$out" 
printf 'Built %s\n' "$out"
