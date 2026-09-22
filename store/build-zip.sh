#!/usr/bin/env bash
# Builds the Chrome Web Store upload package.
#
# Two ways to get this wrong by hand, both of which fail at upload:
#   - zipping the extension/ folder itself, which nests manifest.json one level
#     down; the store requires it at the zip root
#   - shipping the development-only files, which reviewers flag as unexplained
#
# Usage: store/build-zip.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ext="$root/extension"
version="$(node -p "require('$ext/manifest.json').version")"
out="$root/store/sotto-$version.zip"

# Never ship these: test harnesses that do nothing for users.
exclude=("qr.test.js" "test-page.html")

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

cp -R "$ext/." "$staging/"
for f in "${exclude[@]}"; do
  rm -f "$staging/$f"
done

rm -f "$out"
# -j would flatten subdirectories too; cd + "." keeps manifest.json at the root
# while preserving any nested structure.
(cd "$staging" && zip -qr "$out" . -x '.*' '__MACOSX/*')

echo "built: $out"
echo
echo "contents:"

# Listed once into a variable rather than piped per check. Under `pipefail`,
# `unzip | grep -q` reports failure even on a match: grep exits at the first
# hit, unzip takes SIGPIPE, and the pipeline inherits that status — so a
# successful check reads as a failure.
listing="$(unzip -Z1 "$out")"
printf '%s\n' "$listing" | sort | sed 's/^/  /'
echo

if grep -qx "manifest.json" <<<"$listing"; then
  echo "manifest.json is at the zip root — correct"
else
  echo "WARNING: manifest.json is not at the zip root; the store will reject this"
  exit 1
fi

for f in "${exclude[@]}"; do
  if grep -qx "$f" <<<"$listing"; then
    echo "WARNING: $f is still in the package"
    exit 1
  fi
done
echo "no development-only files included"
echo "version $version — ready to upload"
