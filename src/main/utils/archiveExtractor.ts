/**
 * Archive extraction utility for Windows
 *
 * Provides a common extraction function for tar.bz2 archives using
 * Windows native tar command (available since Windows 10 version 1803).
 *
 * Used by both online and offline installers for consistent behavior.
 *
 * CRITICAL: This file must ONLY use Node built-ins, no npm dependencies.
 * It runs during Squirrel events when npm packages may not be available.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { debugLog } from './debugLog';

/**
 * Extract a tar.bz2 archive to a destination directory.
 * Uses Windows native tar command (available since Windows 10 1803).
 *
 * @param archivePath - Path to the tar.bz2 archive
 * @param destDir - Destination directory to extract to
 * @throws Error if extraction fails
 */
export function extractTarBz2(archivePath: string, destDir: string): void {
  debugLog(`Extracting tar.bz2: ${archivePath} -> ${destDir}`);

  // Ensure destination directory exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Windows native tar command
  // -x: extract
  // -j: bzip2 compression
  // -f: archive file
  // -C: change to directory before extracting
  const command = `tar -xjf "${archivePath}" -C "${destDir}"`;

  try {
    execSync(command, {
      timeout: 120000, // 2 minute timeout for large archives
      windowsHide: true,
      stdio: 'pipe', // Capture output to prevent console spam
    });
    debugLog('tar extraction completed successfully');
  } catch (error) {
    debugLog(`tar extraction failed: ${error}`);
    throw new Error(`Failed to extract archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  // Remove dev/ directory if present (contains POSIX special files like symlinks to /dev/fd/)
  // These files cause issues on Windows and are not needed
  const devDir = path.join(destDir, 'dev');
  if (fs.existsSync(devDir)) {
    debugLog('Removing dev/ directory (POSIX special files)');
    try {
      fs.rmSync(devDir, { recursive: true, force: true });
    } catch (error) {
      // Non-fatal - just log and continue
      debugLog(`Warning: Failed to remove dev/ directory: ${error}`);
    }
  }
}

/**
 * Extract node.exe from a Node.js Windows zip archive.
 * Uses PowerShell Expand-Archive since Node.js is distributed as zip.
 *
 * @param zipPath - Path to the Node.js zip archive
 * @param destDir - Directory to extract node.exe to
 * @param nodeVersion - Node.js version (for finding node.exe in archive)
 * @throws Error if extraction fails
 */
export function extractNodeExe(zipPath: string, destDir: string, nodeVersion: string): void {
  debugLog(`Extracting node.exe from: ${zipPath} -> ${destDir}`);

  // Create a temp directory for full extraction
  const tempDir = path.join(destDir, '_node_temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  // Use PowerShell to extract zip (more reliable for zip files on Windows)
  // Security: Use -EncodedCommand with base64 to prevent command injection
  // This avoids all shell escaping issues by encoding the entire command
  const psScript = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`;
  const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

  try {
    execSync(`powershell -NoProfile -EncodedCommand ${encodedCommand}`, {
      timeout: 60000, // 1 minute timeout
      windowsHide: true,
      stdio: 'pipe',
    });
  } catch (error) {
    // Clean up temp directory on failure
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    throw new Error(`Failed to extract Node.js zip: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  // Move node.exe from extracted directory to destination
  const nodeExeSrc = path.join(tempDir, `node-v${nodeVersion}-win-x64`, 'node.exe');
  const nodeExeDest = path.join(destDir, 'node.exe');

  if (!fs.existsSync(nodeExeSrc)) {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`node.exe not found in archive at ${nodeExeSrc}`);
  }

  // Remove existing node.exe if present
  if (fs.existsSync(nodeExeDest)) {
    fs.unlinkSync(nodeExeDest);
  }

  // Copy node.exe to destination
  fs.copyFileSync(nodeExeSrc, nodeExeDest);
  debugLog(`node.exe extracted to: ${nodeExeDest}`);

  // Clean up temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });
}
