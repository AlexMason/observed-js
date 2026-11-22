#!/usr/bin/env bash
# Usage: npm-version-status.sh <package> <version>
# Prints "published" or "unpublished"; exits non-zero on any other npm error,
# so a network or auth failure never looks like "go ahead and publish".
set -euo pipefail

pkg="$1"
version="$2"

if out=$(npm view "${pkg}@${version}" version 2>&1); then
  if [[ "$out" == "$version" ]]; then
    echo published
    exit 0
  fi
  echo "unexpected npm view output: $out" >&2
  exit 1
fi

if grep -q "E404" <<<"$out"; then
  echo unpublished
  exit 0
fi

echo "npm view failed: $out" >&2
exit 1
