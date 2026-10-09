# Build and Release Process

## Prerequisites

- **Local Node version must match CI.** Both use Node 25 (npm 11). Mismatched
  npm versions silently corrupt `package-lock.json` by dropping optional/peer
  dependencies (e.g. `@emnapi/core`, `@emnapi/runtime`), causing CI builds to
  fail with `EUSAGE` / missing package errors.
- Tags `v*` are **protected** on the GitLab remote. They cannot be deleted via
  CLI (`git push origin :refs/tags/...`), only through the GitLab web UI under
  Settings > Repository > Protected Tags. Get it right before tagging.

## Git Hooks (husky)

The pre-commit hook is the first line of defence and it is easy to forget,
because it is **not** part of a fresh checkout — it is installed by the
`prepare` script when `npm install` runs. If it isn't installed, every guard
below is silently skipped and problems surface in CI instead.

Verify before starting a release:

```bash
git config core.hooksPath        # must print .husky/_
```

If it prints nothing, run `npm install` (or `npx husky`) to reinstall, and
confirm again. Never commit with `--no-verify` during a release.

What the hook checks, and why each exists:

- **Lockfile sync** (`npm ci --dry-run`) whenever `package.json` or
  `package-lock.json` is staged. CI installs with `npm ci`, which refuses an
  out-of-sync lockfile and fails *every* job — see Lockfile Integrity below.
  This guard runs on manifest-only commits, which nothing else covers.
- **eslint** on staged `.ts`/`.vue`/`.js` files.
- **typecheck** (`npm run typecheck`).

Watch for the hook's output when you commit (`Verifying package-lock.json is
in sync...`, `Running eslint on staged files...`, `Running typecheck...`). No
output means it did not run — stop and fix that before tagging.

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

### Dependency upgrades (as opposed to version bumps)

A real dependency change must re-resolve, so the rule above cannot apply
as-written. Run the install, then **diff the resulting lockfile's package set
against the last known-good one** — npm prunes transitive deps of *other*
platforms' optional packages (on linux-x64 it drops `@emnapi/core`,
`@emnapi/runtime` and `encoding`). Rebuild by taking the known-good lockfile
and overlaying only the entries the bump actually changed; do not regenerate
from scratch, which drifts hundreds of packages. Confirm with
`npm ci --ignore-scripts --dry-run` before committing.

## Release Checklist

All changes must be committed and verified before tagging. The order matters.

**The single rule that cannot be bent: push the tag before `main`.** The tag
push is what creates the pipeline that builds and publishes the release. Push
`main` first and the tag push silently creates nothing — see step 8, and note
that step 7 pulls in the opposite direction and must give way.

0. **Confirm the hooks are installed** — `git config core.hooksPath` must
   print `.husky/_`. See Git Hooks above. Everything below assumes the
   pre-commit guards actually run.
1. **Make all code changes** and commit them.
2. **Bump version** in `package.json` and `package-lock.json` (direct edit,
   see above). Commit.
3. **Verify the build compiles:**
   ```bash
   npm run typecheck
   ```
4. **Verify the full suite is green** — 0 failed, 0 skipped:
   ```bash
   npm test
   npm run lint       # 0 errors
   ```
5. **Verify lockfile integrity:**
   ```bash
   npm ci --ignore-scripts --dry-run           # must not error
   grep -c '@emnapi/core' package-lock.json    # should be 6
   grep -c '@emnapi/runtime' package-lock.json  # should be 6
   ```
6. **Validate the CI config** if `.gitlab-ci.yml` changed:
   ```bash
   glab ci lint
   ```
7. **Prove the builds before spending a tag.** Tags are protected and cannot
   be deleted from the CLI, so never discover a build failure on a tag. Push
   to `main` first and run the manual build jobs, which use the same
   templates as the tagged ones:
   ```bash
   glab ci trigger build:linux:manual --branch main
   glab ci trigger build:windows:manual --branch main
   glab ci trigger build:windows:online:manual --branch main
   ```
   Skip only when nothing since the last green tag could affect packaging.
   Note `build:windows` (offline) bundles Node.js and Git Bash and is the
   heaviest job — it fails first when the runner is short on memory, so a
   green `build:windows:online` alone does not clear the release.

   **This step conflicts with step 8 and step 8 wins.** Proving the builds
   wants the release commit on `main`; step 8 requires the tag to be pushed
   before `main`. Both cannot hold for the same commit. Resolve it one of
   these ways, never by pushing `main` first and tagging afterwards:
   - Skip this step when the rule above allows it (the common case for a
     source-only change) and go straight to step 8.
   - Otherwise prove the builds on the commit *before* the version bump, then
     bump, tag, and push the tag first. The bump touches only version
     strings, so the packaging result carries over.
8. **Tag and push — the tag FIRST, before `main`:**
   ```bash
   git tag v<version>
   git push origin v<version>
   git push origin main
   ```
   This ordering is not cosmetic and not about CI noise. **Pushing the tag is
   what creates the tag pipeline, and that pipeline is what builds and
   publishes the release.** If `main` already carries the commit, the tag push
   creates no pipeline at all: the tag exists, nothing builds, and no release
   is produced. There is no error — `git push` reports `[new tag]` and the
   release is simply absent.
   This is how v0.19.2-rc.11 was lost. `main` was pushed first (to satisfy
   step 7), the tag was pushed afterwards, and `glab api
   "projects/<id>/pipelines?ref=v0.19.2-rc.11"` returned `[]`. Because tags
   are protected and cannot be deleted from the CLI, the version could not be
   reused — rc.11 was abandoned and rc.12 cut in its place. Pushing the tag
   first on rc.12 created its pipeline immediately.
   After pushing the tag, confirm the pipeline exists before going further:
   ```bash
   glab api "projects/${CI_PROJECT_ID}/pipelines?ref=v<version>"
   ```
   An empty array means no release is coming. Stop and fix it there rather
   than discovering it when the release is missing.
9. **Watch the pipeline to a terminal state** and confirm the release exists:
   ```bash
   glab ci status --branch v<version> --live
   glab release view v<version>
   ```

### If CI fails

Check whether it failed for a *reason in the code* before changing anything.
Jobs on this runner are OOM-killed under memory pressure, which looks like a
mysterious failure but is not one:

- `Killed`, or exit code `137` (SIGKILL), means the OOM killer.
- Read the job log from the top, not the bottom. The `verify` job runs
  `npm ci` before any check, so a kill during the install leaves a log whose
  last lines are `npm warn deprecated ...` then `Killed` — and **no**
  `added N packages` line and no check output at all. That is the install
  dying, not the code. A real failure shows the check's own output
  (`error TS...`, a failing test name, an ESLint rule).
- `before_script` prints `free -h` and the top RSS consumers on the runner —
  read those first. Jobs have been observed failing below ~1Gi available and
  passing above ~1.5Gi.
- The runner is shared with other projects, and their pipelines are the usual
  cause. `resource_group` only serializes *this* project's jobs; it cannot
  hold off another project's. In pipeline 7414 the old `typecheck` job was
  killed while an unrelated project started a test backend and a buildx build
  seconds earlier — both visible in the `docker ps` output `before_script`
  prints, as containers "Up 4 seconds". Check that output for container names
  that aren't ours before suspecting the code.

Re-running the job alone often passes. That is contention, not a fix.

## What Happens After Tagging

Pushing a tag matching `v\d+\.\d+\.\d+` (or `v*-rc.*`) triggers the GitLab CI
pipeline (`.gitlab-ci.yml`):

### Test Stage
- `verify` — ESLint, then vue-tsc + tsc, then Vitest, in one `node:25`
  container after a single `npm ci`. All three run even if an earlier one
  fails, so one pipeline reports every problem; the job fails if any of them
  failed. None of them is allowed to fail.

  It is one job because `npm ci` is the memory peak on this runner and
  running it three times tripled the chance of being OOM-killed — see *If CI
  fails* above.

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
