#!/bin/bash
# Fetch the whisper-cli binary for local development.
#
# The binary is compiled by the vendor:whisper:* CI jobs and published to the
# GitLab package registry — whisper.cpp itself ships no prebuilt binaries, so
# there is nothing upstream to download. This pulls the already-built artifact
# rather than compiling locally, which needs cmake and a C++ toolchain.
#
# Packaged builds get the binary through forge's extraResource; this is only
# for `npm start`, where it lands in vendor/whisper/<platform>/ (gitignored).
#
# Requires PHILIBERT_REGISTRY_URL and, for a private project, a token in
# PHILIBERT_REGISTRY_TOKEN. WHISPER_VERSION must match .gitlab-ci.yml.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CI_FILE="$REPO_ROOT/.gitlab-ci.yml"

# Single source of truth for the version is the CI config, so a bump there is
# the only place it has to change.
WHISPER_VERSION="${WHISPER_VERSION:-$(grep -E '^\s+WHISPER_VERSION:' "$CI_FILE" | head -1 | sed -E 's/.*"(.*)".*/\1/')}"
if [ -z "$WHISPER_VERSION" ]; then
  echo "error: could not read WHISPER_VERSION from $CI_FILE" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux*)  PLATFORM="linux-x64"; BINARY="whisper-cli" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win32-x64"; BINARY="whisper-cli.exe" ;;
  *)
    echo "error: unsupported platform $(uname -s) — the vendor jobs build linux-x64 and win32-x64" >&2
    exit 1
    ;;
esac

if [ -z "${PHILIBERT_REGISTRY_URL:-}" ]; then
  echo "error: set PHILIBERT_REGISTRY_URL to the project's package registry base URL" >&2
  echo "       e.g. https://<host>/api/v4/projects/<id>/packages/generic" >&2
  exit 1
fi

DEST_DIR="$REPO_ROOT/vendor/whisper/$PLATFORM"
DEST="$DEST_DIR/$BINARY"
URL="$PHILIBERT_REGISTRY_URL/whisper/$WHISPER_VERSION/whisper-cli-$PLATFORM"

mkdir -p "$DEST_DIR"

echo "Fetching whisper-cli $WHISPER_VERSION for $PLATFORM..."

AUTH_ARGS=()
if [ -n "${PHILIBERT_REGISTRY_TOKEN:-}" ]; then
  AUTH_ARGS=(--header "PRIVATE-TOKEN: $PHILIBERT_REGISTRY_TOKEN")
fi

# Download to a temporary file and move it into place only on success, so a
# failed fetch cannot leave a truncated binary that looks installed.
TMP="$DEST.partial"
if ! curl --fail --location --silent --show-error "${AUTH_ARGS[@]}" --output "$TMP" "$URL"; then
  rm -f "$TMP"
  echo "error: download failed from $URL" >&2
  echo "       has vendor:whisper:${PLATFORM%%-*} been run for $WHISPER_VERSION?" >&2
  exit 1
fi

mv "$TMP" "$DEST"
chmod +x "$DEST"

echo "Installed $DEST"
"$DEST" --version 2>/dev/null | head -1 || true
