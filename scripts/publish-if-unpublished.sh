#!/usr/bin/env bash
# Publish the package in the current directory with provenance, unless its
# version is already on npm.
set -euo pipefail
name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
if [ -n "$(npm view "$name@$version" version 2>/dev/null || true)" ]; then
  echo "$name@$version is already on npm, skipping"
  exit 0
fi
npm publish --provenance --access public
