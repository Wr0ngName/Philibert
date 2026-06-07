/**
 * Authentication service for Claude Code OAuth login.
 *
 * Uses the Claude CLI `setup-token` command to get an OAuth URL,
 * then sends the user's code back to complete authentication.
 *
 * Uses node-pty for cross-platform PTY support.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { app, shell } from 'electron';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import { MAIN_CONSTANTS } from '../constants/app';
import { stripAnsi } from '../utils/ansi';
import logger from '../utils/logger';
import { renderPtyScreen } from '../utils/ptyScreen';
import { getResourcesPath, WindowsPaths, ClaudeCliPaths } from '../utils/resourcePaths';
import { sanitizeForLog } from '../utils/stringUtils';

import { validateOAuthTokenFormat } from './claude/AuthValidator';

export interface OAuthFlowState {
  pty: IPty | null;
  isPtyAlive: boolean;
  configDir: string;
  createdAt: number;
  output: string;
}

/**
 * Result of OAuth flow completion
 */
export interface OAuthFlowResult {
  success: boolean;
  token?: string;
  credentialsJson?: string;
  error?: string;
}

/**
 * Resource handlers for cleanup during OAuth flow
 */
interface OAuthResourceHandlers {
  dataHandler: { dispose: () => void } | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  resolved: boolean;
  tokenValidationWarned: boolean;
  tokenValidationError: string | null;
  cleanup: () => void;
}

export class AuthService {
  private pendingOAuthFlow: OAuthFlowState | null = null;
  /**
   * Callback invoked when credentials JSON is found AFTER the OAuth promise
   * already resolved (e.g. setup-token writes the file between output
   * extraction and PTY exit).  The IPC handler sets this to save the late
   * credentials for refresh capability.
   */
  onLateCredentials: ((credentialsJson: string) => void) | null = null;

  constructor() {
    logger.info('AuthService initialized');
  }

  /**
   * Get file stats safely, returns null on error
   */
  private safeFileStat(filePath: string): { size: number; mode: string; isFile: boolean; isDir: boolean } | null {
    try {
      const stat = fs.statSync(filePath);
      return {
        size: stat.size,
        mode: stat.mode.toString(8),
        isFile: stat.isFile(),
        isDir: stat.isDirectory(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Read first N bytes of a file to verify content type
   */
  private readFileHead(filePath: string, bytes: number = 100): string | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, 0);
      fs.closeSync(fd);
      // Return printable ASCII only
      return Array.from(buffer)
        .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
        .join('');
    } catch {
      return null;
    }
  }

  /**
   * Find the bundled Git Bash executable for Windows.
   * Claude Code CLI requires git-bash on Windows for Unix-style commands.
   *
   * The git-bash bundle is shipped as a zip and extracted during Squirrel
   * install/update events to resources/git-bash/. This just finds it.
   *
   * Returns the path to bash.exe if found, null otherwise.
   */
  private findBundledGitBash(): string | null {
    if (process.platform !== 'win32') {
      return null;
    }

    const bashExePath = WindowsPaths.getBashExe();

    if (WindowsPaths.hasBundledGitBash()) {
      logger.info('Found bundled Git Bash', { bashExePath });
      return bashExePath;
    }

    logger.warn('Bundled Git Bash not found (should be extracted during install)', {
      expected: bashExePath,
      resourcesPath: getResourcesPath()
    });
    return null;
  }

  /**
   * Find the Claude CLI executable path.
   * Prioritizes the bundled CLI in the app resources.
   */
  private findClaudeCli(): string {
    logger.info('Finding Claude CLI...');

    // First, try the bundled CLI in the app's resources (unpacked from asar)
    const resourcesPath = getResourcesPath();
    logger.info('Resource paths', {
      resourcesPath,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
    });

    const bundledCliPaths = ClaudeCliPaths.getBundledCliPaths();

    // Log all bundled paths we're checking
    for (const cliPath of bundledCliPaths) {
      const exists = fs.existsSync(cliPath);
      const stat = this.safeFileStat(cliPath);
      const head = exists ? this.readFileHead(cliPath, 50) : null;
      logger.info('Checking bundled CLI path', {
        path: cliPath,
        exists,
        stat,
        contentHead: head,
      });
      if (exists) {
        logger.info(`Found bundled Claude CLI at: ${cliPath}`);
        return cliPath;
      }
    }

    // Fallback: Try common system locations
    const possiblePaths = [
      // npm global install
      path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
      path.join(os.homedir(), 'node_modules', '.bin', 'claude'),
      // System PATH - check common locations
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ];

    // On Windows, add .cmd extension
    if (process.platform === 'win32') {
      possiblePaths.unshift(
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
      );
    }

    // Check each path
    for (const p of possiblePaths) {
      const exists = fs.existsSync(p);
      logger.debug('Checking system CLI path', { path: p, exists });
      if (exists) {
        logger.info(`Found Claude CLI at: ${p}`);
        return p;
      }
    }

    // Try to find via which/where command
    try {
      const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
      const result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
      if (result && fs.existsSync(result)) {
        logger.info(`Found Claude CLI via PATH: ${result}`);
        return result;
      }
    } catch (err) {
      logger.debug('Claude CLI not found via which/where command', err);
    }

    // Use npx as fallback (requires Node.js on user's system)
    logger.warn('Claude CLI not found in bundled or system paths, will try npx');
    return 'npx';
  }

  /**
   * Start the OAuth login flow using node-pty.
   * Returns the authorization URL that the user should visit.
   *
   * Based on mautrix-claude sidecar pattern:
   * - Spawns CLI process directly (not through shell)
   * - Uses wide terminal to prevent URL line-wrapping
   * - Captures OAuth URL from output
   * - Keeps PTY alive for code input
   */
  async startOAuthFlow(): Promise<{ authUrl: string; error?: string }> {
    // Clean up any existing flow
    this.cleanupOAuthFlow();

    // DEBUG: Log system info for locale/encoding investigation
    const homeDir = os.homedir();
    const tmpDir = os.tmpdir();
    const locale = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || 'not set';
    const codepage = process.env.CHCP || 'not set';
    logger.info('OAuth flow system info', {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      homeDir,
      homeDirBuffer: Buffer.from(homeDir).toString('hex'),
      tmpDir,
      tmpDirBuffer: Buffer.from(tmpDir).toString('hex'),
      locale,
      codepage,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    });

    // Create temp config directory
    const configDir = path.join(tmpDir, `claude-oauth-${Date.now()}`);
    logger.info('Creating config directory', { configDir, configDirBuffer: Buffer.from(configDir).toString('hex') });
    fs.mkdirSync(configDir, { recursive: true });

    const claudeCli = this.findClaudeCli();
    const isNpx = claudeCli === 'npx';
    const isNativeBinary = ClaudeCliPaths.isNativeBinary(claudeCli);
    const isNodeScript = claudeCli.endsWith('.js') || claudeCli.endsWith('.cjs');

    // Build command and args - spawn DIRECTLY, not through a shell (like mautrix-claude sidecar)
    let spawnFile: string;
    let spawnArgs: string[];
    let extraEnv: Record<string, string> = {};

    if (isNpx) {
      // Fallback: use npx through shell (requires Node.js on system)
      spawnFile = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      spawnArgs = process.platform === 'win32'
        ? ['/c', 'npx @anthropic-ai/claude-code setup-token']
        : ['-c', 'npx @anthropic-ai/claude-code setup-token'];
    } else if (isNativeBinary) {
      // v2.1.121+ native binary — spawn directly, no node.exe needed
      spawnFile = claudeCli;
      spawnArgs = ['setup-token'];
      logger.info(`Using native Claude CLI binary: ${spawnFile}`);
    } else if (isNodeScript) {
      // Legacy cli.js or cli-wrapper.cjs — needs Node.js to execute
      if (process.platform === 'win32') {
        const bundledNodeExe = WindowsPaths.getBundledNodeExe();
        const nodeExeExists = WindowsPaths.hasBundledNode();
        logger.info('Windows: checking bundled Node.js for script execution', {
          bundledNodeExe, exists: nodeExeExists,
        });

        if (nodeExeExists) {
          spawnFile = bundledNodeExe;
          spawnArgs = [claudeCli, 'setup-token'];
        } else {
          logger.warn('Windows: bundled Node.js not found, falling back to ELECTRON_RUN_AS_NODE');
          spawnFile = 'powershell.exe';
          const escapeForPowerShell = (s: string): string => s.replace(/'/g, "''");
          const escapedExePath = escapeForPowerShell(process.execPath);
          const escapedCliPath = escapeForPowerShell(claudeCli);
          const psCommand = `$env:ELECTRON_RUN_AS_NODE='1'; & '${escapedExePath}' '${escapedCliPath}' 'setup-token'`;
          spawnArgs = ['-NoProfile', '-Command', psCommand];
        }
      } else {
        spawnFile = process.execPath;
        spawnArgs = [claudeCli, 'setup-token'];
        extraEnv = { ELECTRON_RUN_AS_NODE: '1' };
      }
      logger.info(`Using Node.js script CLI: ${spawnFile} ${JSON.stringify(spawnArgs)}`);
    } else {
      // System CLI (e.g. /usr/local/bin/claude): spawn directly
      spawnFile = claudeCli;
      spawnArgs = ['setup-token'];
    }

    logger.info('OAuth spawn configuration', {
      spawnFile,
      spawnFileBuffer: Buffer.from(spawnFile).toString('hex'),
      spawnArgs,
      claudeCli,
      claudeCliBuffer: Buffer.from(claudeCli).toString('hex'),
      cliExists: fs.existsSync(claudeCli),
      spawnFileExists: fs.existsSync(spawnFile),
      extraEnv,
    });

    // Find bundled Git Bash for Windows (Claude Code CLI requires it)
    const bundledGitBash = this.findBundledGitBash();
    if (process.platform === 'win32' && bundledGitBash) {
      logger.info('Setting CLAUDE_CODE_GIT_BASH_PATH for bundled Git Bash', { path: bundledGitBash });
      extraEnv.CLAUDE_CODE_GIT_BASH_PATH = bundledGitBash;
    } else if (process.platform === 'win32') {
      logger.warn('Windows: No bundled Git Bash found. Claude CLI may require Git Bash to be installed system-wide.');
    }

    // Environment without browser auto-open (like mautrix-claude sidecar)
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...extraEnv,
      // Prevent browser auto-open: use a command that does nothing
      // On Windows, 'echo' doesn't work as BROWSER - use empty string or cmd /c echo
      BROWSER: process.platform === 'win32' ? 'cmd /c echo' : '/bin/false',
      CLAUDE_CONFIG_DIR: configDir,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    };
    // Prevent X11 browser launch on Linux
    if (process.platform !== 'win32') {
      delete env.DISPLAY;
    }

    // Log key environment variables (not all, for security)
    logger.info('OAuth environment (selected vars)', {
      BROWSER: env.BROWSER,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_GIT_BASH_PATH: env.CLAUDE_CODE_GIT_BASH_PATH,
      TERM: env.TERM,
      NO_COLOR: env.NO_COLOR,
      PATH_length: env.PATH?.length,
      USERPROFILE: env.USERPROFILE,
      USERNAME: env.USERNAME,
      ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE,
    });

    const cwd = os.homedir();
    const cwdHasNonAscii = Array.from(cwd).some(c => c.charCodeAt(0) > 127);
    logger.info('PTY spawn cwd', {
      cwd,
      cwdBuffer: Buffer.from(cwd).toString('hex'),
      hasNonAscii: cwdHasNonAscii,
    });

    return new Promise((resolve) => {
      try {
        logger.info('Creating PTY process...', {
          spawnFile,
          spawnArgs,
          cols: MAIN_CONSTANTS.AUTH.OAUTH_TERMINAL_COLS,
          rows: MAIN_CONSTANTS.AUTH.OAUTH_TERMINAL_ROWS,
          cwd,
          envKeys: Object.keys(env).length,
        });

        // Verify spawn file exists and is accessible right before spawn
        const spawnFileCheck = this.safeFileStat(spawnFile);
        logger.info('Pre-spawn file verification', {
          spawnFile,
          exists: fs.existsSync(spawnFile),
          stat: spawnFileCheck,
        });

        // Create PTY - use wide terminal to prevent URL line-wrapping
        // This is the pattern from mautrix-claude sidecar
        const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
          name: 'xterm-256color',
          cols: MAIN_CONSTANTS.AUTH.OAUTH_TERMINAL_COLS,
          rows: MAIN_CONSTANTS.AUTH.OAUTH_TERMINAL_ROWS,
          cwd,
          env,
        });
        logger.info(`PTY process created, pid: ${ptyProcess.pid}`, {
          pid: ptyProcess.pid,
          // Log process info if available
          processInfo: typeof ptyProcess.process === 'string' ? ptyProcess.process : 'N/A',
        });

        // Handle PTY errors - first handler for immediate logging and alive-state tracking
        ptyProcess.onExit(({ exitCode, signal }) => {
          if (this.pendingOAuthFlow) {
            this.pendingOAuthFlow.isPtyAlive = false;
          }
          if (exitCode !== 0 && exitCode !== null) {
            logger.warn(`PTY process ended abnormally: exitCode=${exitCode}, signal=${signal}`);
          }
        });

        let output = '';
        let rawOutput = ''; // Keep raw output for debugging
        let authUrl = '';
        const startTime = Date.now();
        let resolved = false;
        let dataChunkCount = 0;

        const checkForUrl = () => {
          // Remove ANSI escape codes for parsing
          const clean = stripAnsi(output);

          // Look for the OAuth URL (domain-agnostic to handle claude.ai, claude.com/cai/, etc.)
          const urlMatch = clean.match(/(https:\/\/\S+\/oauth\/authorize\S*)/);
          if (urlMatch && !authUrl) {
            authUrl = urlMatch[1];
            logger.info(`Found OAuth URL (length=${authUrl.length})`);
          }

          // Check if we have URL and prompt (or enough time has passed after finding URL)
          if (authUrl && !resolved && (clean.includes('Paste') || clean.includes('code') || Date.now() - startTime > MAIN_CONSTANTS.AUTH.OAUTH_URL_DETECTION_DELAY_MS)) {
            resolved = true;
            logger.info('OAuth flow ready for code input');
            this.pendingOAuthFlow = {
              pty: ptyProcess,
              isPtyAlive: true,
              configDir,
              createdAt: startTime,
              output,
            };
            resolve({ authUrl });
          }
        };

        // Handle PTY output
        ptyProcess.onData((data: string) => {
          dataChunkCount++;
          output += data;
          rawOutput += data;

          // Log each data chunk for debugging (first 500 chars, hex encoded for non-ASCII safety)
          const dataPreview = data.length > 500 ? data.slice(0, 500) + '...' : data;
          // Sanitize non-printable characters for log readability
          const sanitizedPreview = sanitizeForLog(dataPreview);
          logger.debug(`PTY data chunk #${dataChunkCount}`, {
            length: data.length,
            totalLength: output.length,
            dataHex: Buffer.from(dataPreview).toString('hex').slice(0, 200),
            dataPreview: sanitizedPreview,
          });

          checkForUrl();
        });

        // Timeout after configured duration
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            logger.error('Timeout waiting for OAuth URL', {
              outputLength: output.length,
              dataChunkCount,
              elapsedMs: Date.now() - startTime,
              rawOutputHex: Buffer.from(rawOutput.slice(0, 1000)).toString('hex'),
              cleanOutput: stripAnsi(output).slice(0, 500),
            });
            this.cleanupOAuthFlow();
            resolve({ authUrl: '', error: 'Timeout waiting for authentication URL. Is Claude CLI installed?' });
          }
        }, MAIN_CONSTANTS.AUTH.OAUTH_URL_DETECTION_TIMEOUT_MS);

        ptyProcess.onExit(({ exitCode, signal }) => {
          clearTimeout(timeoutId);
          const elapsedMs = Date.now() - startTime;

          // Log full output on exit for debugging
          const cleanOutput = stripAnsi(output);

          // Analyze the output for common error patterns
          const errorPatterns = {
            moduleNotFound: cleanOutput.includes('Cannot find module') || cleanOutput.includes('MODULE_NOT_FOUND'),
            syntaxError: cleanOutput.includes('SyntaxError'),
            permissionDenied: cleanOutput.includes('EACCES') || cleanOutput.includes('permission denied'),
            fileNotFound: cleanOutput.includes('ENOENT') || cleanOutput.includes('no such file'),
            nodeError: cleanOutput.includes('node:') || cleanOutput.includes('Error:'),
            crashDump: cleanOutput.includes('FATAL ERROR') || cleanOutput.includes('Segmentation fault'),
          };

          logger.info('PTY process exited', {
            exitCode,
            signal,
            elapsedMs,
            outputLength: output.length,
            dataChunkCount,
            resolved,
            errorPatterns,
            immediateExit: elapsedMs < 500,
            noOutput: output.length === 0,
          });

          // If process exited immediately with no output, that's suspicious
          if (elapsedMs < 500 && output.length === 0 && exitCode !== 0) {
            logger.error('PTY exited immediately with no output - likely spawn failure', {
              exitCode,
              signal,
              spawnFile,
              spawnArgs,
              cwd,
            });
          }

          logger.debug('PTY final output (clean)', {
            length: cleanOutput.length,
            content: cleanOutput.slice(0, 2000),
          });
          logger.debug('PTY final output (raw hex)', {
            length: rawOutput.length,
            hex: Buffer.from(rawOutput.slice(0, 1000)).toString('hex'),
          });

          // Give time for output to be processed
          setTimeout(() => {
            checkForUrl();
            if (!resolved) {
              // Build a more helpful error message based on what we found
              let errorMsg = `Authentication process exited (code ${exitCode}).`;

              // Check for specific known errors
              if (cleanOutput.includes('requires git-bash')) {
                errorMsg = 'Claude Code on Windows requires Git Bash. Please install Git for Windows from https://git-scm.com/downloads/win and restart the application.';
              } else if (errorPatterns.moduleNotFound) {
                errorMsg += ' Module not found error - CLI may be corrupted.';
              } else if (errorPatterns.permissionDenied) {
                errorMsg += ' Permission denied - check file permissions.';
              } else if (errorPatterns.fileNotFound) {
                errorMsg += ' File not found - CLI installation may be incomplete.';
              } else if (output.length === 0) {
                errorMsg += ' No output received - process may have crashed immediately.';
              } else {
                errorMsg += ' Check logs for details.';
              }

              logger.error('PTY exited before getting URL', {
                exitCode,
                outputLength: output.length,
                cleanOutputPreview: cleanOutput.slice(0, 500),
                errorPatterns,
              });
              this.cleanupOAuthFlow();
              resolve({ authUrl: '', error: errorMsg });
            }
          }, MAIN_CONSTANTS.AUTH.OAUTH_PROCESS_EXIT_DELAY_MS);
        });
      } catch (error) {
        const err = error as Error;
        logger.error('Failed to start OAuth flow:', err.message);
        logger.error('Stack:', err.stack);
        fs.rmSync(configDir, { recursive: true, force: true });
        resolve({ authUrl: '', error: `Failed to start authentication: ${err.message}` });
      }
    });
  }

  /**
   * Validate OAuth code - just check it's a non-empty string.
   * Let the Claude CLI handle the actual validation.
   *
   * @param code - The OAuth code to validate
   * @returns true if valid, false otherwise
   */
  private isValidOAuthCode(code: string): boolean {
    if (!code || typeof code !== 'string') {
      return false;
    }
    const trimmed = code.trim();
    // Just check it's non-empty and reasonable length - let CLI validate the actual format
    return trimmed.length >= 10 && trimmed.length <= 500;
  }

  /**
   * Complete the OAuth flow by sending the code to the PTY.
   *
   * Based on mautrix-claude sidecar pattern:
   * - Sends code character by character (Ink/Node.js UIs need individual keystrokes)
   * - Sends CR+LF to submit
   * - Reads token from credentials file (primary) or output (fallback)
   */
  async completeOAuthFlow(code: string): Promise<OAuthFlowResult> {
    // Validate flow state
    const validationError = this.validateOAuthFlowState(code);
    if (validationError) {
      return validationError;
    }

    const { pty: ptyProcess, configDir } = this.pendingOAuthFlow!;

    return new Promise((resolve) => {
      const handlers = this.createResourceHandlers();
      let output = this.pendingOAuthFlow!.output;

      try {
        // Listen for PTY output
        handlers.dataHandler = ptyProcess!.onData((data: string) => {
          output += data;
          this.checkOAuthResult(output, configDir, handlers, resolve);
        });

        // Send code to PTY
        this.sendCodeToPty(ptyProcess!, code.trim());

        // Setup polling for result
        this.setupOAuthPolling(handlers, () => output, configDir, resolve);

        // Handle PTY exit
        this.setupPtyExitHandler(ptyProcess!, handlers, () => output, configDir, resolve);
      } catch (error) {
        handlers.cleanup();
        logger.error('Error completing OAuth flow:', error);
        this.cleanupOAuthFlow();
        resolve({ success: false, error: `Authentication error: ${error}` });
      }
    });
  }

  /**
   * Validate OAuth flow state before completing.
   * Returns error result if validation fails, null if valid.
   */
  private validateOAuthFlowState(code: string): OAuthFlowResult | null {
    if (!this.pendingOAuthFlow) {
      return { success: false, error: 'No pending authentication flow. Please start login again.' };
    }

    if (!this.isValidOAuthCode(code)) {
      logger.warn('Invalid OAuth code format', {
        codeLength: code?.length ?? 0,
        codeType: typeof code,
      });
      return { success: false, error: 'Invalid authorization code format. Please copy the full code from the browser.' };
    }

    const { pty: ptyProcess, createdAt } = this.pendingOAuthFlow;

    if (Date.now() - createdAt > MAIN_CONSTANTS.AUTH.OAUTH_TIMEOUT_MS) {
      this.cleanupOAuthFlow();
      return { success: false, error: 'Authentication flow expired. Please start again.' };
    }

    if (!ptyProcess || !this.pendingOAuthFlow.isPtyAlive) {
      this.cleanupOAuthFlow();
      return { success: false, error: 'Authentication process not running. Please start again.' };
    }

    return null;
  }

  /**
   * Create resource handlers for OAuth flow cleanup.
   */
  private createResourceHandlers(): OAuthResourceHandlers {
    const handlers: OAuthResourceHandlers = {
      dataHandler: null,
      pollInterval: null,
      resolved: false,
      tokenValidationWarned: false,
      tokenValidationError: null,
      cleanup: () => {
        if (handlers.dataHandler) {
          handlers.dataHandler.dispose();
          handlers.dataHandler = null;
        }
        if (handlers.pollInterval) {
          clearInterval(handlers.pollInterval);
          handlers.pollInterval = null;
        }
      },
    };
    return handlers;
  }

  /**
   * Send OAuth code to PTY character by character.
   * Ink/Node.js terminal UIs need individual keystrokes.
   */
  private sendCodeToPty(ptyProcess: IPty, code: string): void {
    for (const char of code) {
      ptyProcess.write(char);
    }

    // Send CR+LF to submit (like mautrix-claude sidecar)
    setTimeout(() => {
      ptyProcess.write('\r');
      setTimeout(() => {
        ptyProcess.write('\n');
      }, MAIN_CONSTANTS.AUTH.OAUTH_POLL_INTERVAL_MS / 5);
    }, MAIN_CONSTANTS.AUTH.OAUTH_POLL_INTERVAL_MS / 10);
  }

  /**
   * Check OAuth result in PTY output.
   * Looks for token, credentials file, success message, or error indicators.
   *
   * When a token is found in output, we resolve immediately so the user gets
   * feedback, but we do NOT kill the PTY — the `setup-token` command may still
   * need to finish server-side registration.  The PTY exit handler handles
   * final cleanup and a last-chance credentials-file capture.
   */
  private checkOAuthResult(
    output: string,
    configDir: string,
    handlers: OAuthResourceHandlers,
    resolve: (result: OAuthFlowResult) => void
  ): boolean {
    if (handlers.resolved) return true;

    const clean = stripAnsi(output);

    // ALWAYS check credentials file first - it's the only reliable source
    const credsResult = this.extractTokenFromCredentialsFile(configDir);
    if (credsResult) {
      handlers.resolved = true;
      handlers.cleanup();
      logger.info('OAuth authentication successful via credentials file');
      this.cleanupOAuthFlow();
      resolve({ success: true, token: credsResult.token, credentialsJson: credsResult.credentialsJson });
      return true;
    }

    // Check for success message or token pattern
    const hasSuccessIndicator =
      clean.includes('Successfully authenticated') ||
      clean.includes('logged in') ||
      clean.includes('sk-ant-');

    if (hasSuccessIndicator) {
      logger.info('OAuth success indicator detected, waiting for credentials file');
      this.scheduleCredentialsFileCheck(configDir, handlers, resolve);
    }

    // Fallback: try to extract token from output if credentials file not ready yet
    // This is unreliable due to no whitespace between token and following text,
    // but can work if we detect known junk patterns to trim
    const tokenResult = this.extractTokenFromOutput(clean);
    if (tokenResult) {
      // Gate storage on strict format validation. Two prior versions shipped
      // with PTY ANSI-stripping bugs that corrupted the extracted token by a
      // single byte — the token was stored, every API call 401'd, and the
      // user got logged out repeatedly. Refuse to proceed with a token that
      // doesn't match the known shape.
      //
      // However, do NOT abort the flow — the credentials file (written by
      // setup-token shortly after displaying the token) contains the correct
      // un-corrupted token. Aborting here kills the PTY before it can write
      // that file, which is exactly what happened in v0.17.29. Instead, log
      // the diagnostic and continue waiting for the credentials file.
      let finalToken = tokenResult;
      const validation = validateOAuthTokenFormat(finalToken);
      if (!validation.valid) {
        // stripAnsi discards cursor-movement sequences, which loses
        // characters that the CLI's Ink renderer placed via cursor-forward
        // (ESC[1C) — it skips screen positions whose content didn't change
        // from the previous frame. Render the raw PTY output through a
        // virtual screen buffer that tracks every write, so characters from
        // previous frames survive cursor-forward.
        const rendered = renderPtyScreen(output);
        const renderedToken = this.extractTokenFromOutput(rendered, true);
        if (renderedToken) {
          const renderedValidation = validateOAuthTokenFormat(renderedToken);
          if (renderedValidation.valid) {
            logger.info('Recovered token via PTY screen buffer (cursor-forward had hidden a character)', {
              strippedPrefix: finalToken.slice(0, 14),
              recoveredPrefix: renderedToken.slice(0, 14),
            });
            finalToken = renderedToken;
          }
        }
      }

      // Re-check after screen-buffer recovery attempt
      const finalValidation = validateOAuthTokenFormat(finalToken);
      if (!finalValidation.valid) {
        if (!handlers.tokenValidationWarned) {
          handlers.tokenValidationWarned = true;
          handlers.tokenValidationError = finalValidation.error ?? null;
          const skAntIdx = output.indexOf('sk-ant-');
          const rawWindow = skAntIdx >= 0
            ? output.slice(Math.max(0, skAntIdx - 20), skAntIdx + 140)
            : '';
          const rawHex = Buffer.from(rawWindow, 'utf8').toString('hex');
          logger.warn('OAuth token failed validation even after screen-buffer recovery', {
            reason: finalValidation.error,
            tokenPreview: finalToken.slice(0, 20),
            tokenLength: finalToken.length,
            rawOutputLength: output.length,
            rawWindowAroundSkAntHex: rawHex,
          });
        }
        return false;
      }

      handlers.resolved = true;
      handlers.cleanup();
      logger.info('OAuth authentication successful (extracted from output)', {
        tokenLength: finalToken.length,
        tokenPrefix: finalToken.slice(0, 14),
      });
      // Do NOT call cleanupOAuthFlow() here — let the PTY exit naturally so
      // setup-token can complete its server-side registration.  The PTY exit
      // handler calls cleanupOAuthFlow() after a final credentials-file check.
      resolve({ success: true, token: finalToken });
      return true;
    }

    // Check for error indicators
    if (this.hasErrorIndicators(clean)) {
      handlers.resolved = true;
      handlers.cleanup();
      logger.error('OAuth error detected in output');
      this.cleanupOAuthFlow();
      resolve({ success: false, error: 'Invalid code. Please try again.' });
      return true;
    }

    return false;
  }

  /**
   * Extract OAuth token from CLI output (fallback method).
   *
   * The CLI output often has no whitespace between token and following text, e.g.:
   * "sk-ant-...AAStorethistokensecurely..."
   *
   * We ONLY trim at known junk patterns - no length assumptions.
   * Returns null if no token found or if we can't reliably extract it.
   */
  private extractTokenFromOutput(cleanOutput: string, skipBufferEndGuard = false): string | null {
    // Match any sk-ant- token (don't assume specific format after prefix)
    const tokenMatch = cleanOutput.match(/(sk-ant-[A-Za-z0-9_-]+)/);
    if (!tokenMatch) return null;

    let token = tokenMatch[1];
    const originalLength = token.length;

    // Defer extraction if the match runs to the end of the buffer — i.e. we
    // haven't yet seen a non-token-character boundary after the candidate.
    // The streaming PTY data may have only emitted part of the token so far,
    // and extracting prematurely yields a truncated string that fails
    // downstream format validation and aborts the flow. Real CLI output
    // always emits a newline (or further text) after the token, so by the
    // time the line is genuinely complete the match is bounded by a
    // non-token char. The PTY exit handler does one final check after the
    // full output is in, so we don't risk hanging on a malformed exit.
    const matchEnd = (tokenMatch.index ?? 0) + originalLength;
    const isAtBufferEnd = matchEnd >= cleanOutput.length;
    if (isAtBufferEnd && !skipBufferEndGuard) {
      return null;
    }

    // Only trim at known junk patterns that indicate where the token ends
    const junkPatterns = [
      'Store',      // "Store your token securely" / "Storethistokensecurely"
      'You',        // "You won't be able to see it again"
      'Use',        // "Use this token by setting"
      'This',       // "This is your..."
      'Keep',       // "Keep this token..."
      'Save',       // "Save this token..."
      'Please',     // "Please save..."
      'Copy',       // "Copy this token..."
      'Note',       // "Note: ..."
    ];

    for (const junk of junkPatterns) {
      const junkIndex = token.indexOf(junk);
      if (junkIndex > 0) {
        logger.info('Trimming junk from OAuth token', {
          junkPattern: junk,
          junkIndex,
          originalLength,
        });
        token = token.substring(0, junkIndex);
        break;
      }
    }

    if (token.length !== originalLength) {
      logger.info('OAuth token trimmed', { originalLength, finalLength: token.length });
    }

    logger.debug('Extracted OAuth token from output', { length: token.length });
    return token;
  }

  /**
   * Extract OAuth token and full credentials from credentials file.
   */
  private extractTokenFromCredentialsFile(configDir: string): { token: string; credentialsJson: string } | null {
    const credsFile = path.join(configDir, '.credentials.json');
    if (!fs.existsSync(credsFile)) return null;

    try {
      const raw = fs.readFileSync(credsFile, 'utf8');
      const creds = JSON.parse(raw);
      const token = creds.oauthToken || creds.claudeAiOauth?.accessToken;
      if (token && typeof token === 'string') {
        // Strict-validate even though the credentials file is normally
        // a trusted source — if it contains garbage, surface that rather
        // than blindly storing it.
        const validation = validateOAuthTokenFormat(token);
        if (validation.valid) {
          return { token, credentialsJson: raw };
        }
        logger.warn('Credentials file token failed format validation — ignoring', {
          reason: validation.error,
          tokenLength: token.length,
          tokenPrefix: token.slice(0, 14),
        });
      }
    } catch {
      // Credentials file not ready yet
    }
    return null;
  }

  /**
   * Schedule a delayed check of the credentials file after success message.
   */
  private scheduleCredentialsFileCheck(
    configDir: string,
    handlers: OAuthResourceHandlers,
    resolve: (result: OAuthFlowResult) => void
  ): void {
    setTimeout(() => {
      if (handlers.resolved) return;
      const credsResult = this.extractTokenFromCredentialsFile(configDir);
      if (credsResult) {
        handlers.resolved = true;
        handlers.cleanup();
        logger.info('OAuth authentication successful');
        this.cleanupOAuthFlow();
        resolve({ success: true, token: credsResult.token, credentialsJson: credsResult.credentialsJson });
      }
    }, MAIN_CONSTANTS.AUTH.OAUTH_CREDENTIALS_CHECK_DELAY_MS);
  }

  /**
   * Check if output contains error indicators.
   */
  private hasErrorIndicators(cleanOutput: string): boolean {
    const lowerClean = cleanOutput.toLowerCase();
    return (
      (lowerClean.includes('invalid code') ||
        lowerClean.includes('error:') ||
        lowerClean.includes('failed')) &&
      !lowerClean.includes('no error')
    );
  }

  /**
   * Setup polling interval for OAuth result.
   */
  private setupOAuthPolling(
    handlers: OAuthResourceHandlers,
    getOutput: () => string,
    configDir: string,
    resolve: (result: OAuthFlowResult) => void
  ): void {
    let attempts = 0;
    handlers.pollInterval = setInterval(() => {
      attempts++;
      if (this.checkOAuthResult(getOutput(), configDir, handlers, resolve)) {
        handlers.cleanup();
        return;
      }
      if (attempts >= MAIN_CONSTANTS.AUTH.OAUTH_POLL_MAX_ATTEMPTS) {
        if (!handlers.resolved) {
          handlers.resolved = true;
          handlers.cleanup();
          logger.error('Timeout waiting for OAuth completion');
          this.cleanupOAuthFlow();
          resolve({ success: false, error: 'Timeout waiting for authentication to complete' });
        }
      }
    }, MAIN_CONSTANTS.AUTH.OAUTH_POLL_INTERVAL_MS);
  }

  /**
   * Setup PTY exit handler.
   * Always cleans up the OAuth flow after PTY exits.  When the promise was
   * already resolved (e.g. token extracted from output), we do a final
   * credentials-file check and emit a late-credentials event so the caller
   * can upgrade to the full JSON if available.
   */
  private setupPtyExitHandler(
    ptyProcess: IPty,
    handlers: OAuthResourceHandlers,
    getOutput: () => string,
    configDir: string,
    resolve: (result: OAuthFlowResult) => void
  ): void {
    ptyProcess.onExit(({ exitCode }) => {
      logger.info(`OAuth PTY exited with code ${exitCode}`);
      setTimeout(() => {
        // Always clean up — even if we already resolved from output extraction,
        // the PTY and temp dir still need cleanup.
        if (!handlers.resolved) {
          this.checkOAuthResult(getOutput(), configDir, handlers, resolve);
          if (!handlers.resolved) {
            handlers.resolved = true;
            handlers.cleanup();
            this.cleanupOAuthFlow();
            const error = handlers.tokenValidationError
              ? `Authentication captured a malformed token (${handlers.tokenValidationError}). The credentials file was not written before the CLI exited. Please try logging in again.`
              : 'Authentication failed. Please try again.';
            resolve({ success: false, error });
          }
        } else {
          // Already resolved (from output extraction).  Do a final
          // credentials-file check — setup-token may have written it between
          // our resolve and the PTY exiting.  Save it async if found.
          const credsResult = this.extractTokenFromCredentialsFile(configDir);
          if (credsResult) {
            logger.info('Late credentials file found after PTY exit — saving for refresh capability');
            this.onLateCredentials?.(credsResult.credentialsJson);
          }
          this.cleanupOAuthFlow();
        }
      }, MAIN_CONSTANTS.CLAUDE.INTERRUPT_DELAY_MS);
    });
  }

  /**
   * Open the OAuth URL in the user's default browser.
   */
  openAuthUrl(url: string): void {
    shell.openExternal(url);
  }

  /**
   * Check if there's a pending OAuth flow.
   */
  hasPendingFlow(): boolean {
    return this.pendingOAuthFlow !== null;
  }

  /**
   * Clean up any pending OAuth flow.
   * Properly handles PTY termination and temp directory cleanup.
   */
  cleanupOAuthFlow(): void {
    if (!this.pendingOAuthFlow) {
      return;
    }

    const { pty: ptyProcess, configDir } = this.pendingOAuthFlow;

    // Kill PTY process first
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (err) {
        logger.debug('PTY already terminated during cleanup', err);
      }
    }

    // Clear state immediately to prevent duplicate cleanup
    this.pendingOAuthFlow = null;

    // Clean up temp directory after a delay to ensure PTY has released files
    if (configDir) {
      setTimeout(() => {
        try {
          if (fs.existsSync(configDir)) {
            fs.rmSync(configDir, { recursive: true, force: true });
            logger.debug('Temp config directory cleaned up', { configDir });
          }
        } catch (err) {
          logger.debug('Temp config directory already removed or inaccessible', err);
        }
      }, MAIN_CONSTANTS.AUTH.PTY_CLEANUP_DELAY_MS);
    }

    logger.info('OAuth flow cleaned up');
  }

}

export default AuthService;
