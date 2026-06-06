#!/usr/bin/env bash
# Build the Next.js frontend and sync its static export into the Python package.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here/frontend"
npm ci
npm run build                         # output: export -> ./out
dest="$here/src/kodeks/static"
rm -rf "$dest"
mkdir -p "$dest"
cp -R out/. "$dest/"
echo "Frontend built into src/kodeks/static/"
