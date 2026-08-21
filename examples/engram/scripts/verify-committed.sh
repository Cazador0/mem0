#!/usr/bin/env bash
# Run the test suite against what git ACTUALLY committed, not the working tree.
#
# Why this exists: the repo-root .gitignore had a bare `db` pattern that matched
# examples/engram/src/db/, so the entire storage layer was silently excluded
# from every commit. Local runs stayed green for weeks because they read the
# working tree; `git status` says nothing about ignored paths. Only extracting
# the committed tree and running it there catches that class of mistake.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
prefix=$(git rev-parse --show-prefix)          # e.g. examples/engram/ (from HERE, not root)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$root" archive HEAD "${prefix%/}" | tar -x -C "$work"
extracted="$work/${prefix%/}"

if [ ! -f "$extracted/src/db/database.ts" ]; then
  echo "FAIL: src/db/database.ts is missing from the committed tree (gitignored?)" >&2
  exit 1
fi

ln -s "$root/${prefix}node_modules" "$extracted/node_modules"
cd "$extracted"
echo "running the suite against HEAD ($(git -C "$root" rev-parse --short HEAD))"
bun test
