# Build and Release Process

## Prerequisites

- **Local Node version must match CI.** Both use Node 25 (npm 11). Mismatched
  npm versions silently corrupt `package-lock.json` by dropping optional/peer
  dependencies (e.g. `@emnapi/core`, `@emnapi/runtime`), causing CI builds to
  fail with `EUSAGE` / missing package errors.
- Tags `v*` are **protected** on the GitLab remote. They cannot be deleted via
  CLI (`git push origin :refs/tags/...`), only through the GitLab web UI under
  Settings > Repository > Protected Tags. Get it right before tagging.

## Version Bump

**Never run `npm install --package-lock-only` or any npm command that
re-resolves the lockfile.** Different npm versions resolve dependencies
differently, which can silently drop packages CI needs.

Instead, edit version strings directly:

1. Edit `package.json`: change the `"version"` field.
2. Edit `package-lock.json`: change both occurrences of the version string
   (line ~3 at the top level, and line ~9 under `packages["""]`).
3. If the lockfile was corrupted, restore it from the last known-good commit
   first: `git checkout <commit> -- package-lock.json`, then edit the version
   strings.

## Release Checklist

All changes must be committed and verified before tagging. The order matters.

1. **Make all code changes** and commit them.
2. **Bump version** in `package.json` and `package-lock.json` (direct edit,
   see above). Commit.
3. **Verify the build compiles:**
   ```bash
   npx vue-tsc -p tsconfig.renderer.json --noEmit
   npx tsc -p tsconfig.main.json --noEmit
   npx tsc -p tsconfig.preload.json --noEmit
   ```
4. **Verify lockfile integrity** (emnapi packages present):
   ```bash
   grep -c '@emnapi/core' package-lock.json    # should be 6
   grep -c '@emnapi/runtime' package-lock.json  # should be 6
   ```
5. **Tag and push** (tag first, then main):
   ```bash
   git tag v<version>
   git push origin v<version>
   git push origin main
   ```

## What Happens After Tagging

Pushing a tag matching `v\d+\.\d+\.\d+` (or `v*-rc.*`) triggers the GitLab CI
pipeline (`.gitlab-ci.yml`):

### Test Stage (parallel)
- `lint` — ESLint in a `node:25` container
- `test` — Vitest in a `node:25` container
- `typecheck` — vue-tsc + tsc (allowed to fail)

### Build Stage (parallel)
- `build:linux` — DEB + RPM packages via `electron-forge make` in a `node:25`
  container with `build-essential`, `python3`, `dpkg`, `fakeroot`, `rpm`
- `build:windows` — NSIS offline installer (bundles Node.js + Git) via
  `electronuserland/builder:wine-mono` with Node 25 installed at runtime
- `build:windows:online` — NSIS online installer (downloads Node.js + Git
  during install, smaller download)

### Release Stage (sequential)
1. `publish:packages` — uploads all artifacts to the GitLab Package Registry
   at `${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/releases/<version>/`.
   Generates `latest.yml` (SHA-512 hash + metadata) for electron-updater.
2. `create:release` — creates a GitLab Release with download links for all
   platforms and variants.

### Cleanup Stage
- `cleanup:old` — runs `scripts/cleanup-old-releases.sh` inside an alpine
  container with `curl` + `jq`. Policy depends on which tag triggered the
  pipeline (`CI_COMMIT_TAG`):
  - **RC pipeline** (`vX.Y.Z-rc.N`): keeps **only the just-shipped RC**
    and deletes every other RC. Stable releases and stable packages are
    not touched.
  - **Stable pipeline** (`vX.Y.Z`): deletes **every RC** (across all
    versions), then keeps the **last `KEEP_LAST_N` stable releases**
    (default 3).
  - Anything else (manual run, unexpected tag): no-op.

  Both branches apply the same shape to the Releases API and the Package
  Registry. Marked `allow_failure: true` so a transient API issue won't
  fail the release pipeline.

### Auto-Updates
- `src/main/services/UpdateService.ts` queries the **Releases API**
  (`/api/v4/projects/.../releases`) to find the latest tag for the user's
  update channel, then points electron-updater at the Package Registry
  (`/api/v4/projects/.../packages/generic/releases/<version>/latest.yml`)
  to download the installer.
- Auto-updates always download the offline (full) installer.
- RC releases (`v*-rc.*`) only reach users whose update channel is set to "rc".
- Because the auto-updater reads from the Releases API and Package Registry
  (not job artifacts), the `cleanup:old` job can safely prune both — as long
  as at least one release survives, users can still update.

## Manual Builds

On the `main` branch (without a tag), Linux and Windows builds can be triggered
manually from the GitLab CI/CD Pipelines page. These do not produce release
artifacts.

## Troubleshooting

### CI fails with "Missing: @emnapi/core" or similar lockfile errors
The lockfile was corrupted by running `npm install` with a different npm
version. Fix: restore from the last known-good commit and edit version strings
directly (see Version Bump above).

### Cannot delete a tag
Tags are protected. Delete via GitLab web UI: Settings > Repository >
Protected Tags, or Tags page > delete button.

### Build fails in `electronuserland/builder:wine-mono`
This container doesn't include Node.js by default. The CI script installs it
via `nodesource` at runtime. If the Node version changes, update the
`NODE_VERSION` variable in `.gitlab-ci.yml`.
