import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import type { MakerRpmConfigOptions } from '@electron-forge/maker-rpm/dist/Config';
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

      console.log('Installing external modules:', pinnedModules);

      const runNpm = (args: string[]) => new Promise<void>((resolve, reject) => {
        const npm = spawn('npm', args, {
          cwd: buildPath,
          stdio: 'inherit',
          shell: true,
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

      // Install one module at a time rather than in a single npm call. Two of
      // these pull a large platform binary (the bundled Claude Code CLI alone
      // is ~265MB), and installing them together means npm extracts several
      // at once — a peak this build host cannot afford. Sequential installs
      // are slightly slower but hold a much lower high-water mark.
      const npmFlags = ['--no-package-lock', '--no-save', '--no-audit', '--no-fund'];
      for (const mod of pinnedModules) {
        console.log(`Installing external module: ${mod}`);
        await runNpm(['install', ...npmFlags, mod]);
      }

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
      // Use --force to bypass the platform check.
      if (claudeCodeVersion) {
        const crossPlatformPkg = `${platformPkg}@${claudeCodeVersion}`;
        console.log(`Installing cross-platform binary: ${crossPlatformPkg}`);
        await runNpm(['install', ...npmFlags, '--force', crossPlatformPkg]);
      }

      // After install, the postinstall may have placed the HOST platform's binary
      // (e.g. Linux) into bin/claude.exe. Overwrite with the TARGET platform binary.
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
      unpack: '**/node_modules/{node-pty,@anthropic-ai,@img}/**/*',
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
  rebuildConfig: {
    // Rebuild native modules for the target platform
    onlyModules: ['node-pty'],
    force: true,
  },
  makers: [
    // Windows NSIS installer is built separately via electron-builder (see electron-builder.json)
    // Forge handles packaging only; electron-builder creates the installer from the packaged app
    new MakerZIP({}, ['darwin']),
    new MakerRpm({
      options: {
        icon: './resources/icons/icon.png',
        categories: ['Development'],
        requires: ['git'],
        scripts: {
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
