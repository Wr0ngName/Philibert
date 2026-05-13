/**
 * Download dependencies for Windows online installer
 *
 * Downloads Node.js and Git for online bundles (smaller initial download).
 * Versions and URLs are read from resources/windows-deps.json.
 */

import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { app } from 'electron';

import { extractNodeExe } from './archiveExtractor';
import { debugLog } from './debugLog';
import { getResourcesPath, WindowsPaths } from './resourcePaths';

interface WindowsDepsConfig {
  node: {
    version: string;
    url: string;
    sha256: string;
  };
  git: {
    version: string;
    url: string;
    sha256: string | null;
  };
}

function loadDepsConfig(): WindowsDepsConfig {
  const resourcesPath = getResourcesPath();
  const configPath = path.join(resourcesPath, 'windows-deps.json');
  const fallbackPath = path.join(__dirname, '..', '..', '..', 'resources', 'windows-deps.json');

  let configFile = configPath;
  if (!fs.existsSync(configFile)) {
    configFile = fallbackPath;
  }

  if (!fs.existsSync(configFile)) {
    throw new Error(`Windows deps config not found at ${configPath} or ${fallbackPath}`);
  }

  const content = fs.readFileSync(configFile, 'utf8');
  return JSON.parse(content) as WindowsDepsConfig;
}

function verifyChecksum(filePath: string, expectedHash: string): void {
  debugLog(`Verifying SHA256 checksum for ${filePath}...`);

  const fileBuffer = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(fileBuffer);
  const actualHash = hash.digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${path.basename(filePath)}!\n` +
      `  Expected: ${expectedHash}\n` +
      `  Actual:   ${actualHash}`
    );
  }

  debugLog('Checksum verified OK');
}

function downloadFile(url: string, destPath: string, maxRetries = 3): void {
  debugLog(`Downloading: ${url}`);
  debugLog(`  -> ${destPath}`);

  const parentDir = path.dirname(destPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const command = `curl.exe -L --fail --progress-bar -o "${destPath}" "${url}"`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync(command, {
        timeout: 600000,
        windowsHide: true,
        stdio: 'pipe',
      });
      debugLog(`Download complete: ${destPath}`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (fs.existsSync(destPath)) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      }

      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        debugLog(`Download attempt ${attempt}/${maxRetries} failed. Retrying in ${backoffMs / 1000}s...`);
        execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${backoffMs}"`, {
          windowsHide: true,
        });
      }
    }
  }

  throw new Error(`Failed to download after ${maxRetries} attempts: ${url}\n${lastError?.message || 'Unknown error'}`);
}

function downloadAndExtractNode(config: WindowsDepsConfig): void {
  const resourcesPath = getResourcesPath();
  const nodeExeDest = path.join(resourcesPath, 'node.exe');

  if (fs.existsSync(nodeExeDest)) {
    debugLog('Node.js already exists, skipping download');
    return;
  }

  // For "All Users" installs, resources/ is not writable — download to userData
  let targetDir = resourcesPath;
  try {
    fs.accessSync(resourcesPath, fs.constants.W_OK);
  } catch {
    targetDir = app.getPath('userData');
    debugLog(`Resources dir not writable, downloading Node.js to ${targetDir}`);
  }

  const altNodeExe = path.join(targetDir, 'node.exe');
  if (fs.existsSync(altNodeExe)) {
    debugLog('Node.js already exists at fallback location, skipping download');
    return;
  }

  const nodeZip = path.join(targetDir, '_node_download.zip');

  try {
    debugLog(`Downloading Node.js v${config.node.version}...`);
    downloadFile(config.node.url, nodeZip);
    verifyChecksum(nodeZip, config.node.sha256);

    debugLog('Extracting node.exe...');
    extractNodeExe(nodeZip, targetDir, config.node.version);

    debugLog('Node.js download and extraction complete');
  } finally {
    if (fs.existsSync(nodeZip)) {
      try { fs.unlinkSync(nodeZip); } catch { /* ignore */ }
    }
  }
}

function downloadGitArchive(config: WindowsDepsConfig): void {
  // Archive goes into the writable extraction dir's parent so it's next to git-bash/
  const extractionDir = WindowsPaths.getGitBashExtractionDir();
  const parentDir = path.dirname(extractionDir);
  const gitArchive = path.join(parentDir, 'git-bash.tar.bz2');
  const versionFile = path.join(parentDir, 'git-version.txt');

  // Also check the bundled archive in resources (offline installs)
  const bundledArchive = WindowsPaths.getGitBashArchive();
  const bundledVersion = WindowsPaths.getGitBashVersionFile();
  if (fs.existsSync(bundledArchive) && fs.existsSync(bundledVersion)) {
    try {
      const existingVersion = fs.readFileSync(bundledVersion, 'utf8').trim();
      if (existingVersion === config.git.version) {
        debugLog('Git archive already exists in resources with correct version, skipping download');
        return;
      }
    } catch {
      // Continue with download
    }
  }

  if (fs.existsSync(gitArchive) && fs.existsSync(versionFile)) {
    try {
      const existingVersion = fs.readFileSync(versionFile, 'utf8').trim();
      if (existingVersion === config.git.version) {
        debugLog('Git archive already exists with correct version, skipping download');
        return;
      }
    } catch {
      // Continue with download
    }
  }

  try {
    debugLog(`Downloading Git for Windows v${config.git.version}...`);
    downloadFile(config.git.url, gitArchive);

    if (config.git.sha256) {
      verifyChecksum(gitArchive, config.git.sha256);
    } else {
      debugLog('No checksum available for Git, relying on HTTPS security');
    }

    fs.writeFileSync(versionFile, config.git.version);
    debugLog('Git download complete');
  } catch (error) {
    if (fs.existsSync(gitArchive)) {
      try { fs.unlinkSync(gitArchive); } catch { /* ignore */ }
    }
    throw error;
  }
}

/**
 * Download all dependencies for online installer.
 * Called during first-run setup when bundle type is 'online'.
 */
export function downloadDependenciesForOnlineInstall(): void {
  if (process.platform !== 'win32') {
    return;
  }

  debugLog('=== Online installer: downloading dependencies ===');

  try {
    const config = loadDepsConfig();
    debugLog(`Node.js version: ${config.node.version}`);
    debugLog(`Git version: ${config.git.version}`);

    downloadAndExtractNode(config);
    downloadGitArchive(config);

    debugLog('=== All dependencies downloaded successfully ===');
  } catch (error) {
    debugLog(`ERROR downloading dependencies: ${error}`);
  }
}
