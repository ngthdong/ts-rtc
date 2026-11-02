#!/usr/bin/env bash
# Lines of runtime code (no tests, no E2E, no config, no blank or comment lines) for the
# per-stage budget. Usage: scripts/loc.sh [git-rev]   (default: the working tree)
set -euo pipefail
rev=${1:-}
list() { if [ -n "$rev" ]; then git ls-tree -r --name-only "$rev"; else git ls-files -co --exclude-standard; fi; }
show() { if [ -n "$rev" ]; then git show "$rev:$1"; else cat "$1"; fi; }
list | grep -E '^(apps|packages)/[^/]+/src/.*\.tsx?$' | grep -vE '\.test\.tsx?$' |
  while read -r file; do show "$file"; done |
  grep -vE '^\s*($|//|/\*|\*)' | wc -l
