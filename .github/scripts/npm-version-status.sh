#!/usr/bin/env bash
# Usage: npm-version-status.sh <package> <version>
# Prints "published" or "unpublished"; exits non-zero on any other npm error,
# so a network or auth failure never looks like "go ahead and publish".
set -euo pipefail

pkg="$1"
version="$2"

# Compare stdout only; npm writes warnings and errors to stderr.
err=$(mktemp)
trap 'rm -f "$err"' EXIT

if out=$(npm view "${pkg}@${version}" version 2>"$err"); then
  if [[ "$out" == "$version" ]]; then
    echo published
    exit 0
  fi
  echo "unexpected npm view output: $out" >&2
  exit 1
fi

if grep -q "E404" "$err"; then
  echo unpublished
  exit 0
fi

echo "npm view failed:" >&2
cat "$err" >&2
exit 1
