#!/usr/bin/env sh
# Delete older releases and Package Registry versions, keeping the last N
# most recent (by released_at / created_at). Runs from the `cleanup:old` CI
# job after a successful release pipeline, so there is always at least one
# release left for users to update to.
#
# Reads from the environment:
#   CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN — provided by GitLab CI
#   KEEP_LAST_N                                — retention count (default 3)
#
# Requires: curl, jq (the CI job runs this inside `alpine` with both installed).
#
# A note on the package registry: GitLab keeps one "generic package" per
# (name, version) pair, with the uploaded files as sub-resources. Deleting
# the package id removes every file in that version atomically, so we only
# need to enumerate package ids, not individual files.

set -eu

KEEP_LAST_N="${KEEP_LAST_N:-3}"
API="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
HDR="JOB-TOKEN: ${CI_JOB_TOKEN}"

echo "=== Cleanup: keeping the last ${KEEP_LAST_N} releases + package versions ==="

# ---------------------------------------------------------------------------
# Releases
# ---------------------------------------------------------------------------
echo "--- Releases ---"
# GET /releases sorts by released_at desc by default. per_page=100 covers
# any realistic backlog; if you ever exceed it the oldest will just survive
# this run and be picked up next time.
RELEASES_JSON=$(curl -fsS --header "$HDR" "${API}/releases?per_page=100")
RELEASES_COUNT=$(echo "$RELEASES_JSON" | jq 'length')
echo "Found ${RELEASES_COUNT} release(s) total."

# Phase 1: superseded-RC cleanup.
# An RC tag has the form `vX.Y.Z-rc.N`. Once the matching stable `vX.Y.Z`
# ships, the RCs are obsolete previews of the same release — delete them
# regardless of date so the release list and Package Registry stay clean.
ALL_TAGS=$(echo "$RELEASES_JSON" | jq -r '.[].tag_name')
STABLE_BASES=$(echo "$ALL_TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)

SUPERSEDED_RCS=''
if [ -n "$STABLE_BASES" ]; then
  for BASE in $STABLE_BASES; do
    MATCHING_RCS=$(echo "$ALL_TAGS" | grep -E "^${BASE}-rc\." || true)
    if [ -n "$MATCHING_RCS" ]; then
      SUPERSEDED_RCS="${SUPERSEDED_RCS}${MATCHING_RCS}
"
    fi
  done
fi

if [ -n "$SUPERSEDED_RCS" ]; then
  echo "Found superseded RC(s) — stable equivalent already shipped:"
  echo "$SUPERSEDED_RCS" | sed 's/^/  /'
  echo "$SUPERSEDED_RCS" | while IFS= read -r TAG; do
    [ -z "$TAG" ] && continue
    echo "Deleting superseded RC ${TAG}..."
    curl -fsS --request DELETE --header "$HDR" "${API}/releases/${TAG}" \
      && echo "  ok" \
      || echo "  FAILED for ${TAG}"
  done
else
  echo "No superseded RCs to clean up."
fi

# Phase 2: keep-last-N on whatever remains.
# Re-fetch so the slice indices reflect the post-Phase-1 state.
RELEASES_JSON=$(curl -fsS --header "$HDR" "${API}/releases?per_page=100")
OLD_TAGS=$(echo "$RELEASES_JSON" | jq -r --argjson n "$KEEP_LAST_N" '.[$n:] | .[].tag_name')
if [ -z "$OLD_TAGS" ]; then
  echo "Nothing else to delete (under retention threshold)."
else
  echo "$OLD_TAGS" | while IFS= read -r TAG; do
    [ -z "$TAG" ] && continue
    echo "Deleting release ${TAG}..."
    curl -fsS --request DELETE --header "$HDR" "${API}/releases/${TAG}" \
      && echo "  ok" \
      || echo "  FAILED for ${TAG}"
  done
fi

# ---------------------------------------------------------------------------
# Package Registry (generic packages)
# ---------------------------------------------------------------------------
echo "--- Packages (generic) ---"
PACKAGES_JSON=$(curl -fsS --header "$HDR" \
  "${API}/packages?package_type=generic&per_page=100&order_by=created_at&sort=desc")
PACKAGES_COUNT=$(echo "$PACKAGES_JSON" | jq 'length')
echo "Found ${PACKAGES_COUNT} package version(s) total."

# Phase 1: superseded-RC cleanup. Package versions match release tags
# without the leading `v` (e.g. release `v0.17.35-rc.1` → package `0.17.35-rc.1`).
STABLE_PKG_VERSIONS=$(echo "$PACKAGES_JSON" | jq -r '.[].version' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true)

SUPERSEDED_PKG_IDS=''
if [ -n "$STABLE_PKG_VERSIONS" ]; then
  for STABLE in $STABLE_PKG_VERSIONS; do
    IDS=$(echo "$PACKAGES_JSON" | jq -r --arg s "$STABLE" \
      '.[] | select(.version | startswith($s + "-rc.")) | "\(.id) \(.version)"')
    if [ -n "$IDS" ]; then
      SUPERSEDED_PKG_IDS="${SUPERSEDED_PKG_IDS}${IDS}
"
    fi
  done
fi

if [ -n "$SUPERSEDED_PKG_IDS" ]; then
  echo "Found superseded RC package(s) — stable equivalent already shipped:"
  echo "$SUPERSEDED_PKG_IDS" | sed 's/^/  /'
  echo "$SUPERSEDED_PKG_IDS" | while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    ID=$(echo "$LINE" | cut -d' ' -f1)
    VERSION=$(echo "$LINE" | cut -d' ' -f2-)
    echo "Deleting superseded RC package id=${ID} (version ${VERSION})..."
    curl -fsS --request DELETE --header "$HDR" "${API}/packages/${ID}" \
      && echo "  ok" \
      || echo "  FAILED for id=${ID}"
  done
else
  echo "No superseded RC packages to clean up."
fi

# Phase 2: keep-last-N on whatever remains.
PACKAGES_JSON=$(curl -fsS --header "$HDR" \
  "${API}/packages?package_type=generic&per_page=100&order_by=created_at&sort=desc")
DELETE_PKGS=$(echo "$PACKAGES_JSON" | jq -r --argjson n "$KEEP_LAST_N" \
  '.[$n:] | .[] | "\(.id) \(.version)"')

if [ -z "$DELETE_PKGS" ]; then
  echo "Nothing else to delete (under retention threshold)."
else
  echo "$DELETE_PKGS" | while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    ID=$(echo "$LINE" | cut -d' ' -f1)
    VERSION=$(echo "$LINE" | cut -d' ' -f2-)
    echo "Deleting package id=${ID} (version ${VERSION})..."
    curl -fsS --request DELETE --header "$HDR" "${API}/packages/${ID}" \
      && echo "  ok" \
      || echo "  FAILED for id=${ID}"
  done
fi

echo "=== Cleanup complete ==="
