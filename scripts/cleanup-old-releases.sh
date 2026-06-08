#!/usr/bin/env sh
# Branching cleanup policy driven by the pipeline's CI_COMMIT_TAG.
#
# RC pipeline (tag matches `vX.Y.Z-rc.N`):
#   - Releases: keep only the just-shipped RC; delete every other RC.
#               Stable releases are not touched.
#   - Packages: same shape — keep only the just-shipped RC package version;
#               delete every other RC package. Stable packages untouched.
#
# Stable pipeline (tag matches `vX.Y.Z`):
#   - Releases: delete every RC, then keep the most recent KEEP_LAST_N
#               stable releases (default 3).
#   - Packages: mirror.
#
# Anything else (manual run, weird tag): no-op with a log message — we
# don't want to wipe production registry data because of an unexpected
# CI invocation.
#
# Reads from the environment:
#   CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN — provided by GitLab CI
#   CI_COMMIT_TAG                              — release tag that triggered the pipeline
#   KEEP_LAST_N                                — stable retention count (default 3)
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
TAG="${CI_COMMIT_TAG:-}"

# Classify the current pipeline's tag.
if [ -z "$TAG" ]; then
  MODE="unknown"
elif echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  MODE="stable"
elif echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'; then
  MODE="rc"
else
  MODE="unknown"
fi

# Package versions are the tag without the leading `v`.
CURRENT_PKG_VERSION=$(echo "$TAG" | sed 's/^v//')

echo "=== Cleanup mode: ${MODE} (tag: ${TAG:-<none>}) ==="

if [ "$MODE" = "unknown" ]; then
  echo "No supported tag on this pipeline — skipping all cleanup."
  exit 0
fi

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

if [ "$MODE" = "rc" ]; then
  # Delete every RC tag except the just-shipped one. Stables untouched.
  TARGETS=$(echo "$RELEASES_JSON" | jq -r --arg cur "$TAG" \
    '.[] | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$")) | select(.tag_name != $cur) | .tag_name')

  if [ -z "$TARGETS" ]; then
    echo "No older RC releases to clean up."
  else
    echo "Deleting older RC release(s):"
    echo "$TARGETS" | sed 's/^/  /'
    echo "$TARGETS" | while IFS= read -r T; do
      [ -z "$T" ] && continue
      curl -fsS --request DELETE --header "$HDR" "${API}/releases/${T}" \
        && echo "  ok: ${T}" \
        || echo "  FAILED: ${T}"
    done
  fi
else
  # Stable pipeline: delete EVERY RC first, then keep last N stable releases.
  RC_TARGETS=$(echo "$RELEASES_JSON" | jq -r \
    '.[] | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$")) | .tag_name')

  if [ -z "$RC_TARGETS" ]; then
    echo "No RC releases to sweep."
  else
    echo "Sweeping all RC release(s) (stable now shipping):"
    echo "$RC_TARGETS" | sed 's/^/  /'
    echo "$RC_TARGETS" | while IFS= read -r T; do
      [ -z "$T" ] && continue
      curl -fsS --request DELETE --header "$HDR" "${API}/releases/${T}" \
        && echo "  ok: ${T}" \
        || echo "  FAILED: ${T}"
    done
  fi

  # Re-fetch and prune stable releases past keep-last-N. /releases is sorted
  # by released_at desc by default, and the filter keeps that order.
  RELEASES_JSON=$(curl -fsS --header "$HDR" "${API}/releases?per_page=100")
  STABLE_OLD=$(echo "$RELEASES_JSON" | jq -r --argjson n "$KEEP_LAST_N" \
    '[.[] | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | .[$n:] | .[].tag_name')

  if [ -z "$STABLE_OLD" ]; then
    echo "Under stable retention threshold (${KEEP_LAST_N}); nothing else to delete."
  else
    echo "Deleting stable release(s) past keep-last-${KEEP_LAST_N}:"
    echo "$STABLE_OLD" | sed 's/^/  /'
    echo "$STABLE_OLD" | while IFS= read -r T; do
      [ -z "$T" ] && continue
      curl -fsS --request DELETE --header "$HDR" "${API}/releases/${T}" \
        && echo "  ok: ${T}" \
        || echo "  FAILED: ${T}"
    done
  fi
fi

# ---------------------------------------------------------------------------
# Package Registry (generic packages)
# ---------------------------------------------------------------------------
echo "--- Packages (generic) ---"
PACKAGES_JSON=$(curl -fsS --header "$HDR" \
  "${API}/packages?package_type=generic&per_page=100&order_by=created_at&sort=desc")
PACKAGES_COUNT=$(echo "$PACKAGES_JSON" | jq 'length')
echo "Found ${PACKAGES_COUNT} package version(s) total."

if [ "$MODE" = "rc" ]; then
  # Keep only the just-shipped RC package; delete every other RC package.
  TARGETS=$(echo "$PACKAGES_JSON" | jq -r --arg cur "$CURRENT_PKG_VERSION" \
    '.[] | select(.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$")) | select(.version != $cur) | "\(.id) \(.version)"')

  if [ -z "$TARGETS" ]; then
    echo "No older RC packages to clean up."
  else
    echo "Deleting older RC package(s):"
    echo "$TARGETS" | sed 's/^/  /'
    echo "$TARGETS" | while IFS= read -r L; do
      [ -z "$L" ] && continue
      ID=$(echo "$L" | cut -d' ' -f1)
      curl -fsS --request DELETE --header "$HDR" "${API}/packages/${ID}" \
        && echo "  ok: id=${ID}" \
        || echo "  FAILED: id=${ID}"
    done
  fi
else
  # Stable pipeline: nuke every RC package, then keep last N stable packages.
  RC_PKG_TARGETS=$(echo "$PACKAGES_JSON" | jq -r \
    '.[] | select(.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$")) | "\(.id) \(.version)"')

  if [ -z "$RC_PKG_TARGETS" ]; then
    echo "No RC packages to sweep."
  else
    echo "Sweeping all RC package(s) (stable now shipping):"
    echo "$RC_PKG_TARGETS" | sed 's/^/  /'
    echo "$RC_PKG_TARGETS" | while IFS= read -r L; do
      [ -z "$L" ] && continue
      ID=$(echo "$L" | cut -d' ' -f1)
      curl -fsS --request DELETE --header "$HDR" "${API}/packages/${ID}" \
        && echo "  ok: id=${ID}" \
        || echo "  FAILED: id=${ID}"
    done
  fi

  PACKAGES_JSON=$(curl -fsS --header "$HDR" \
    "${API}/packages?package_type=generic&per_page=100&order_by=created_at&sort=desc")
  STABLE_PKG_OLD=$(echo "$PACKAGES_JSON" | jq -r --argjson n "$KEEP_LAST_N" \
    '[.[] | select(.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))] | .[$n:] | .[] | "\(.id) \(.version)"')

  if [ -z "$STABLE_PKG_OLD" ]; then
    echo "Under stable package retention threshold (${KEEP_LAST_N}); nothing else to delete."
  else
    echo "Deleting stable package(s) past keep-last-${KEEP_LAST_N}:"
    echo "$STABLE_PKG_OLD" | sed 's/^/  /'
    echo "$STABLE_PKG_OLD" | while IFS= read -r L; do
      [ -z "$L" ] && continue
      ID=$(echo "$L" | cut -d' ' -f1)
      curl -fsS --request DELETE --header "$HDR" "${API}/packages/${ID}" \
        && echo "  ok: id=${ID}" \
        || echo "  FAILED: id=${ID}"
    done
  fi
fi

echo "=== Cleanup complete ==="
