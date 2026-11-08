#!/usr/bin/env bash
# Write electron-updater's Linux feed, latest-linux.yml, to stdout.
#
#   scripts/write-linux-update-feed.sh <version> <deb> <rpm> > latest-linux.yml
#
# On Linux the updater reads latest-linux.yml, not latest.yml (which is the
# Windows feed), and installs the file of its own kind from `files`: the .deb
# for an install from the .deb, the .rpm for one from the .rpm. Each URL is
# the file's name, resolved against the release's package folder, where the
# release job uploads it under that name. sha512 is hex, as in latest.yml;
# electron-updater reads a 128-character sha512 as hex.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <version> <deb> <rpm>" >&2
  exit 2
fi

VERSION=$1
DEB=$2
RPM=$3

for file in "$DEB" "$RPM"; do
  if [ ! -f "$file" ]; then
    echo "$0: no such file: $file" >&2
    exit 1
  fi
done

entry() {
  printf '  - url: %s\n    sha512: %s\n    size: %s\n' \
    "$(basename "$1")" "$(sha512sum "$1" | cut -d' ' -f1)" "$(stat -c %s "$1")"
}

printf 'version: %s\n' "$VERSION"
printf 'files:\n'
entry "$DEB"
entry "$RPM"
# The top-level path and sha512 are the older single-file form, which
# electron-updater still reads when `files` is missing; they name the .deb.
printf 'path: %s\n' "$(basename "$DEB")"
printf 'sha512: %s\n' "$(sha512sum "$DEB" | cut -d' ' -f1)"
printf 'releaseDate: %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
