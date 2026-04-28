import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Check if we're building for Windows (either native or cross-compiling)
// The make command sets --platform=win32 which we can detect via npm_config_platform
const isWindowsBuild = process.platform === 'win32' ||
  process.env.npm_config_platform === 'win32' ||
  process.argv.includes('--platform=win32');

// Online bundle mode: Set CLINE_ONLINE_BUILD=true to build without bundled Node.js/Git
// Online installers download these dependencies during Squirrel installation
const isOnlineBuild = process.env.CLINE_ONLINE_BUILD === 'true';

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

const config: ForgeConfig = {
  hooks: {
    // Generate bundle-type.txt before packaging starts
    generateAssets: async () => {
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

      console.log('Installing external modules:', pinnedModules);

      return new Promise<void>((resolve, reject) => {
        const npm = spawn('npm', ['install', '--no-package-lock', '--no-save', ...pinnedModules], {
          cwd: buildPath,
          stdio: 'inherit',
          shell: true,
        });

        npm.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`npm install exited with code: ${code}`));
          }
        });

        npm.on('error', reject);
      });
    },
  },
  packagerConfig: {
    name: 'Cline GUI',
    executableName: 'cline-gui',
    asar: {
      unpack: '**/node_modules/{node-pty,@anthropic-ai,@img}/**/*',
    },
    icon: './resources/icons/icon',
    appBundleId: 'com.cline.gui',
    appCategoryType: 'public.app-category.developer-tools',
    // Bundle dependencies for Windows:
    // OFFLINE builds include Node.js and Git Bash in the bundle
    // ONLINE builds download them during Squirrel installation
    //
    // - Node.js: Required because Windows GUI apps can't capture stdout from ELECTRON_RUN_AS_NODE
    // - Git Bash (as tar.bz2): Required by Claude Code CLI for Unix-style commands
    //   Bundled as tar.bz2 directly; extracted during Squirrel install using Windows native tar
    // Run scripts/download-node-windows.sh and scripts/download-git-bash-windows.sh before building
    // Also include app-update.yml for electron-updater and bundle-type.txt for online/offline detection
    extraResource: [
      './resources/app-update.yml',
      // Bundle type marker file (online or offline) - always included for Windows
      ...(isWindowsBuild ? [bundleTypeFile] : []),
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
    new MakerSquirrel({
      name: 'cline-gui',
      authors: 'wrongname',
      description: 'Desktop GUI for Claude Code - AI-powered coding assistant',
      setupIcon: './resources/icons/icon.ico',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({
      options: {
        icon: './resources/icons/icon.png',
        categories: ['Development'],
        // Git is required by Claude Code CLI
        requires: ['git'],
        // scripts.postun: RPM post-uninstall script
        // @ts-expect-error MakerRpm supports scripts via electron-installer-redhat but types are incomplete
        scripts: {
          postun: './resources/linux/postrm.rpm',
        },
      },
    }),
    new MakerDeb({
      options: {
        icon: './resources/icons/icon.png',
        categories: ['Development'],
        maintainer: 'wrongname',
        homepage: 'https://dev.web.wr0ng.name/wrongname/cline-gui',
        // Git is required by Claude Code CLI
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
