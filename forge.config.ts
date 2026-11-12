import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import type { MakerRpmConfigOptions } from '@electron-forge/maker-rpm';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

// Check if we're building for Windows (either native or cross-compiling)
// The make command sets --platform=win32 which we can detect via npm_config_platform
const isWindowsBuild = process.platform === 'win32' ||
  process.env.npm_config_platform === 'win32' ||
  process.argv.includes('--platform=win32');

// Online bundle mode: Set PHILIBERT_ONLINE_BUILD=true to build without bundled Node.js/Git
// Online installers download these dependencies on first run
const isOnlineBuild = process.env.PHILIBERT_ONLINE_BUILD === 'true';

// Check if bundled Node.js exists for Windows builds
const nodeExePath = './vendor/node-win-x64/node.exe';
const hasNodeExe = fs.existsSync(nodeExePath);

// Check if bundled Git Bash archive exists for Windows builds
// Claude Code CLI requires git-bash on Windows for Unix-style commands
// We bundle tar.bz2 directly (no conversion) - Windows 10+ has native tar command
const gitBashArchive = './vendor/git-bash-win-x64/git-bash.tar.bz2';
const gitBashVersionFile = './vendor/git-bash-win-x64/version.txt';
const hasGitBashArchive = fs.existsSync(gitBashArchive) && fs.existsSync(gitBashVersionFile);

// Bundle type marker file path
const bundleTypeFile = './resources/bundle-type.txt';

/**
 * The RPM maker, with nothing in the package stripped.
 *
 * rpmbuild strips every ELF binary it packages by default. The bundled Claude
 * CLI is a Bun executable whose program is appended after the ELF sections,
 * and stripping cuts that off: what is left is the bare Bun runtime, which
 * answers `--version` with Bun's own version and fails every SDK call with
 * `Script not found "stream-json"`. So on an install from the .rpm the app
 * could not talk to Claude at all. The .deb maker does not strip.
 *
 * electron-installer-redhat's spec turns stripping off only when
 * cross-building (`%global __strip /bin/true`), and takes no template of its
 * own, so the same line is put at the top of the spec it writes, for the
 * length of this make.
 */
class MakerRpmUnstripped extends MakerRpm {
  async make(...args: Parameters<MakerRpm['make']>): ReturnType<MakerRpm['make']> {
    // The module the maker imports, so the same installer it creates: ESM
    // from installer v4 (Forge 8), where createContents still calls each step
    // by name on the instance, createSpec among them.
    const { Installer } = await import('electron-installer-redhat');
    const createSpec = Installer.prototype.createSpec;
    Installer.prototype.createSpec = async function (this: typeof Installer.prototype) {
      await createSpec.call(this);
      const spec = await fs.promises.readFile(this.specPath, 'utf8');
      await fs.promises.writeFile(this.specPath, `%global __strip /bin/true\n${spec}`);
    };
    try {
      return await super.make(...args);
    } finally {
      Installer.prototype.createSpec = createSpec;
    }
  }
}

// Channel server output path (built by esbuild during generateAssets)
const channelServerOutput = './out/channel-server.cjs';

// whisper-cli for local speech-to-text, compiled by the vendor:whisper:* CI
// jobs (whisper.cpp publishes no prebuilt binaries) and fetched into vendor/
// by scripts/fetch-whisper.sh. Packaged under resources/whisper/<platform>/
// so WhisperPaths finds it outside the asar.
//
// Absence is not a build failure: a build made before the vendor job ran
// simply ships without dictation, and the feature reports itself unavailable
// rather than appearing and failing on click.
const whisperPlatformDir = isWindowsBuild ? 'win32-x64' : 'linux-x64';
const whisperBinaryName = isWindowsBuild ? 'whisper-cli.exe' : 'whisper-cli';
const whisperBinary = `./vendor/whisper/${whisperPlatformDir}/${whisperBinaryName}`;
// The directory is what gets packaged, so the layout under resources matches
// what WhisperPaths looks for: resources/whisper/<platform>/<binary>.
const whisperResourceDir = './vendor/whisper';
const hasWhisperBinary = fs.existsSync(whisperBinary);

const config: ForgeConfig = {
  hooks: {
    generateAssets: async () => {
      // Build channel server (required for channel mode at runtime)
      console.log('\x1b[36mBuilding channel-server...\x1b[0m');
      execSync('npm run build:channel-server', { stdio: 'inherit' });
      console.log('Channel server built successfully');

      if (isWindowsBuild) {
        const bundleType = isOnlineBuild ? 'online' : 'offline';
        console.log(`\x1b[36mBundle type: ${bundleType}\x1b[0m`);

        // Write bundle-type.txt to resources directory
        fs.writeFileSync(bundleTypeFile, bundleType);
        console.log(`Created ${bundleTypeFile} with value: ${bundleType}`);
      }
    },
    // Workaround for Electron Forge Vite bug #3738:
    // External modules are not included in the package. Reinstall them after pruning.
    // https://github.com/electron/forge/issues/3738#issuecomment-3199157664
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform) => {
      // Warn if building for Windows without bundled dependencies (offline build only)
      if (platform === 'win32' && !isOnlineBuild) {
        if (!hasNodeExe) {
          console.warn('\x1b[33m⚠ WARNING: Building OFFLINE bundle without bundled Node.js!\x1b[0m');
          console.warn('  OAuth login will not work. Run: ./scripts/download-node-windows.sh');
        }
        if (!hasGitBashArchive) {
          console.warn('\x1b[33m⚠ WARNING: Building OFFLINE bundle without bundled Git Bash!\x1b[0m');
          console.warn('  Claude Code CLI requires Git Bash. Run: ./scripts/download-git-bash-windows.sh');
        }
      } else if (platform === 'win32' && isOnlineBuild) {
        console.log('\x1b[36mBuilding ONLINE bundle - Node.js and Git will be downloaded during installation\x1b[0m');
      }
      // Dynamically import vite config to get external modules list
      const viteConfig = await import('./vite.main.config');
      const rawExternal = viteConfig?.default?.build?.rollupOptions?.external;
      const external: string[] = Array.isArray(rawExternal) ? rawExternal as string[] : [];

      if (external.length === 0) {
        console.log('No external modules to install');
        return;
      }

      // Filter out 'electron' as it's provided by the runtime
      const modulesToInstall = external.filter((m: string) => m !== 'electron');

      // Pin each module to the exact version from our package-lock.json so that
      // a newer release with breaking structural changes (e.g. cli.js → native
      // binary) doesn't slip in during the build.
      const rootPkgLock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'));
      const pinnedModules = modulesToInstall.map((m: string) => {
        const locked = rootPkgLock.packages?.[`node_modules/${m}`]?.version;
        return locked ? `${m}@${locked}` : m;
      });

      // claude-code v2.1.121+ ships a native binary via platform-specific optional
      // deps (e.g. @anthropic-ai/claude-code-win32-x64). When cross-compiling
      // (Linux Docker → win32), npm installs the host platform's binary, not the
      // target's. Explicitly add the target platform package so the correct binary
      // gets bundled.
      const claudeCodeVersion = rootPkgLock.packages?.['node_modules/@anthropic-ai/claude-code']?.version;
      const arch = 'x64'; // all current builds target x64
      const platformPkg = `@anthropic-ai/claude-code-${platform}-${arch}`;

      const runNpm = (args: string[]) => new Promise<void>((resolve, reject) => {
        const npm = spawn('npm', args, {
          cwd: buildPath,
          stdio: 'inherit',
          // Only Windows needs a shell, to run npm.cmd; elsewhere the arguments
          // are passed as they are, unconcatenated (Node's DEP0190).
          shell: process.platform === 'win32',
        });
        npm.on('close', (code, signal) => {
          if (code === 0) return resolve();

          // Both branches below name the OOM killer, because it is by far the
          // most common cause here: the host has 5.7Gi and no swap, and this
          // step peaks while npm extracts a ~265MB binary and node-gyp builds
          // node-pty. Saying only "exited with code: 137" once sent a
          // diagnosis looking for a dependency fault.
          const OOM = 'almost certainly the OOM killer; this host has no swap';

          // A process killed by a signal reports a null exit code, so the code
          // alone says nothing — the previous version printed
          // "exited with code: null" for exactly this case.
          if (signal) {
            const hint = signal === 'SIGKILL' ? ` (${OOM})` : '';
            return reject(new Error(`npm install was killed by ${signal}${hint}`));
          }

          // 137 is SIGKILL as an intervening shell reports it.
          const hint = code === 137 ? ` (SIGKILL — ${OOM})` : '';
          reject(new Error(`npm install exited with code: ${code}${hint}`));
        });
        npm.on('error', reject);
      });

      // What the package ships of each module is decided in
      // scripts/package-contents.mjs; a module it says nothing about would
      // ship whole, unexamined.
      const contents = await import('./scripts/package-contents.mjs');
      const undecided = contents.modulesWithoutRuntimeFiles(modulesToInstall);
      if (undecided.length > 0) {
        throw new Error(
          `External module(s) ${undecided.join(', ')} have no entry in scripts/package-contents.mjs: ` +
          'say there which of their files the app uses.',
        );
      }

      // The packaged app's package.json is ours as written, and npm installs
      // what it lists: every production dependency (vue, pinia, marked… — 180
      // packages, 45 MB in app.asar, none loaded: the bundles hold their
      // code), and with no lock file it resolves the devDependencies from the
      // registry too, even when not installing them — so a dev tool's broken
      // release failed the v0.25.7 build with ETARGET. It lists the external
      // modules only, at the locked versions.
      const packagedPkgPath = path.join(buildPath, 'package.json');
      const packagedPkg = JSON.parse(fs.readFileSync(packagedPkgPath, 'utf8'));
      delete packagedPkg.devDependencies;
      packagedPkg.dependencies = Object.fromEntries(pinnedModules.map((pinned: string, i: number) => {
        const name = modulesToInstall[i];
        return [name, pinned === name ? '*' : pinned.slice(name.length + 1)];
      }));
      fs.writeFileSync(packagedPkgPath, `${JSON.stringify(packagedPkg, null, 2)}\n`);

      // - optional: the platform packages of the Claude CLI and the agent SDK
      //   — the build host's, not the target's, and the app runs neither: the
      //   target's binary is installed and placed below.
      // - peers, by not resolving them (--legacy-peer-deps): the agent SDK's
      //   (the Anthropic and MCP SDKs, zod), none loaded by its
      //   self-contained entry point. --omit=peer is not enough: it leaves the
      //   peers out but still installs their 95 dependencies (express…).
      // - scripts, when the target is not the build host: they build for the
      //   host — node-pty compiled a Linux pty.node into every Windows
      //   package — and the target's prebuilt files are what runs there.
      const npmFlags = [
        '--no-package-lock', '--no-audit', '--no-fund', '--omit=dev', '--omit=optional', '--legacy-peer-deps',
        ...(platform === process.platform ? [] : ['--ignore-scripts']),
      ];
      console.log('Installing external modules:', pinnedModules);
      await runNpm(['install', ...npmFlags]);

      // Check what actually landed, instead of trusting that the loop above
      // ran to completion.
      //
      // Note what this can and cannot catch. It catches an install that
      // *returned* without producing the module. It does NOT catch the failure
      // that prompted it — on a memory-starved runner the npm child was killed
      // and the rejection never reached Forge, so execution never got past the
      // `await` above and nothing below it ran at all. That case is caught
      // outside Forge, by scripts/verify-package.mjs, via the manifest written
      // at the end of this hook.
      const missingModules = modulesToInstall.filter(
        (mod: string) => !fs.existsSync(path.join(buildPath, 'node_modules', mod)),
      );
      if (missingModules.length > 0) {
        throw new Error(
          `Packaging incomplete: ${missingModules.join(', ')} ` +
          `${missingModules.length === 1 ? 'is' : 'are'} missing from ` +
          `${path.join(buildPath, 'node_modules')} after installing. ` +
          'The install above did not finish — on this build host that is usually the OOM ' +
          'killer. Do not chase the next error in the log: anything electron-builder reports ' +
          'about a missing file under out/ is a symptom of this.',
        );
      }

      // Platform-specific binary packages have os/cpu restrictions that npm rejects
      // during cross-compilation (e.g. installing win32 package on Linux).
      // Use --force to bypass the platform check. Only its binary is used —
      // copied into place below, the package then trimmed away — so it is
      // neither saved to package.json nor given a chance to run a script.
      if (claudeCodeVersion) {
        const crossPlatformPkg = `${platformPkg}@${claudeCodeVersion}`;
        console.log(`Installing cross-platform binary: ${crossPlatformPkg}`);
        await runNpm(['install', ...npmFlags, '--no-save', '--ignore-scripts', '--force', crossPlatformPkg]);
      }

      // bin/claude.exe is a placeholder until a binary is put there: the
      // CLI's postinstall finds no platform package (optional ones are
      // omitted) and leaves it. Put the TARGET platform's binary there.
      const binName = platform === 'win32' ? 'claude.exe' : 'claude';
      const srcBin = path.join(buildPath, 'node_modules', platformPkg, binName);
      const destBin = path.join(buildPath, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(srcBin)) {
        fs.copyFileSync(srcBin, destBin);
        if (platform !== 'win32') {
          fs.chmodSync(destBin, 0o755);
        }
        console.log(`Placed ${platform}-${arch} claude binary at bin/claude.exe`);
      } else if (claudeCodeVersion) {
        // We just installed the package that provides this binary, so its
        // absence means that install was incomplete — the same failure the
        // module check above catches, one step later.
        //
        // A warning was not enough. Without the target binary the package
        // ships with the *build host's* Claude CLI (a Linux ELF inside a
        // Windows installer), which fails the first time a user sends a
        // message, with nothing in the build log pointing back here. Both
        // currently passing builds reach the "Placed …" line above, so this is
        // not a path a healthy build takes.
        throw new Error(
          `Platform binary missing at ${srcBin} after installing ` +
          `${platformPkg}@${claudeCodeVersion}. The package would ship with the build ` +
          `host's Claude binary instead of the ${platform}-${arch} one.`,
        );
      } else {
        // No version resolved from the lockfile, so the cross-platform install
        // was skipped entirely and there is nothing to have failed.
        console.warn(`\x1b[33m⚠ WARNING: Platform binary not found at ${srcBin}\x1b[0m`);
        console.warn('  No @anthropic-ai/claude-code version in package-lock.json to install from.');
      }

      // Only what the app uses on this platform is left: no source, build or
      // debug files, no other platform's binaries, no second copy of one.
      // Throws if a file it needs is missing afterwards.
      const removed = contents.trimToRuntime(path.join(buildPath, 'node_modules'), platform);
      console.log(`Removed ${(removed / 1048576).toFixed(1)} MB the app does not use on ${platform}`);

      // Record what this hook installed — the LAST thing it does.
      //
      // Its position is the point. scripts/verify-package.mjs runs between
      // packaging and making, and treats a missing manifest as a failed
      // packaging run. That catches the failure no in-hook check can: when the
      // npm child is killed by the OOM killer the rejection does not reach
      // Forge, execution stops at the `await` and never reaches any later
      // check — but it never reaches this write either, so the absent manifest
      // is the signal.
      //
      // The module list is written rather than hard-coded anywhere, so the
      // check stays derived from the Vite config's `external` and cannot drift
      // from what packaging actually needs.
      const manifestPath = path.join(__dirname, 'out', `.philibert-externals-${platform}.json`);
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({ platform, arch, modules: modulesToInstall, completedAt: new Date().toISOString() }, null, 2),
      );
      console.log(`Wrote packaging manifest ${manifestPath}`);
    },
  },
  packagerConfig: {
    name: 'Philibert',
    executableName: isWindowsBuild ? 'Philibert' : 'philibert',
    asar: {
      // The external modules: native files and an executable, run from disk.
      unpack: '**/node_modules/{node-pty,@anthropic-ai}/**/*',
    },
    icon: './resources/icons/icon',
    appBundleId: 'com.philibert.app',
    appCategoryType: 'public.app-category.developer-tools',
    // Bundle dependencies for Windows:
    // OFFLINE builds include Node.js and Git Bash in the bundle
    // ONLINE builds download them on first run
    //
    // - Node.js: Required because Windows GUI apps can't capture stdout from ELECTRON_RUN_AS_NODE
    // - Git Bash (as tar.bz2): Required by Claude Code CLI for Unix-style commands
    //   Bundled as tar.bz2 directly; extracted on first run using Windows native tar
    // Run scripts/download-node-windows.sh and scripts/download-git-bash-windows.sh before building
    // Also include app-update.yml for electron-updater and bundle-type.txt for online/offline detection
    extraResource: [
      './resources/app-update.yml',
      channelServerOutput,
      // Bundle type marker file (online or offline) - always included for Windows
      ...(isWindowsBuild ? [bundleTypeFile] : []),
      // Local speech-to-text binary, when a build has one
      ...(hasWhisperBinary ? [whisperResourceDir] : []),
      // Only include Node.js and Git for OFFLINE builds
      ...(isWindowsBuild && !isOnlineBuild && hasNodeExe ? [nodeExePath] : []),
      ...(isWindowsBuild && !isOnlineBuild && hasGitBashArchive ? [gitBashArchive, gitBashVersionFile] : []),
    ],
  },
  // No rebuildConfig: Forge rebuilds native modules after copying the app,
  // before packageAfterPrune installs node-pty — there is nothing to rebuild
  // then (CI logs: "Preparing native dependencies" ends before "Installing
  // external modules"). node-pty is N-API: on Linux it is compiled by its own
  // install script, on Windows its prebuilt files are used.
  makers: [
    // Windows NSIS installer is built separately via electron-builder (see electron-builder.json)
    // Forge handles packaging only; electron-builder creates the installer from the packaged app
    new MakerZIP({}, ['darwin']),
    new MakerRpmUnstripped({
      options: {
        icon: './resources/icons/icon.png',
        categories: ['Development'],
        requires: ['git'],
        scripts: {
          post: './resources/linux/postinst.rpm',
          postun: './resources/linux/postrm.rpm',
        },
      } as MakerRpmConfigOptions,
    }),
    new MakerDeb({
      options: {
        icon: './resources/icons/icon.png',
        categories: ['Development'],
        maintainer: 'wrongname',
        homepage: 'https://dev.web.wr0ng.name/wrongname/philibert',
        depends: ['git'],
        scripts: {
          postinst: './resources/linux/postinst',
          postrm: './resources/linux/postrm',
        },
      },
    }),
  ],
  plugins: [
    // Auto-unpack native modules for runtime access
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // Enable RunAsNode to allow using Electron as Node.js for the bundled Claude CLI
      // This is required for OAuth authentication with the Claude CLI
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
