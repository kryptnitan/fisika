#!/usr/bin/env bash
# Usage: publish.sh <branch> <message> <file>...
# Adds files to a results branch without wiping what other jobs published; retries on push races.
set -euo pipefail
branch=$1; msg=$2; shift 2
work=$(mktemp -d)
git config --global user.name "fisika-ci"
git config --global user.email "fisika-ci@users.noreply.github.com"
url=$(git remote get-url origin)
auth=$(git config --get http.https://github.com/.extraheader || true)
for attempt in 1 2 3 4 5; do
  rm -rf "$work"; mkdir -p "$work"; cd "$work"
  git init -q
  [ -n "$auth" ] && git config http.https://github.com/.extraheader "$auth"
  git remote add origin "$url"
  if git fetch -q --depth 1 origin "$branch" 2>/dev/null; then git checkout -q -B "$branch" FETCH_HEAD; else git checkout -q --orphan "$branch"; fi
  for f in "$@"; do cp "$f" .; git add "$(basename "$f")"; done
  git commit -qm "$msg" || { echo "nothing to publish"; exit 0; }
  if git push -q origin "HEAD:$branch"; then echo "published to $branch"; exit 0; fi
  sleep $((attempt * 3))
done
echo "publish failed after retries" >&2
exit 1
