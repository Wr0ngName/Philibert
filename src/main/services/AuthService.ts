/**
 * Authentication service for Claude Code OAuth login.
 *
 * Runs the CLI's `auth login --claudeai` to get an OAuth URL, sends the
 * user's code back, and takes the login from the files the CLI writes: its
 * credentials (refreshable — see cliCredentials.ts) and the account record.
 *
 * It used to run `setup-token`, which issues a one-year token scoped to
 * inference only: no refresh, and nothing that says whose account it is, so
 * the settings could never show which account was logged in.
 *
 * Uses node-pty for cross-platform PTY support.
 */

import { execFile, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { app, shell } from 'electron';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import { MAIN_CONSTANTS } from '../constants/app';
import { stripAnsi } from '../utils/ansi';
import logger from '../utils/logger';
import { getResourcesPath, WindowsPaths, ClaudeCliPaths } from '../utils/resourcePaths';
import { sanitizeForLog } from '../utils/stringUtils';

import { validateOAuthTokenFormat } from './claude/AuthValidator';
import { accessTokenOf, cliConfigDir, readCliCredentials } from './claude/cliCredentials';

/** The CLI command that logs in with a Claude subscription. */
const LOGIN_ARGS = ['auth', 'login', '--claudeai'];
/** The CLI command that logs out. */
const LOGOUT_ARGS = ['auth', 'logout'];

export interface OAuthFlowState {
  pty: IPty | null;
  isPtyAlive: boolean;
  /** The CLI's credentials when the flow started; a login is a change from these. */
  baselineCredentials: string | null;
  createdAt: number;
  output: string;
}

/**
 * Result of OAuth flow completion
 */
export interface OAuthFlowResult {
  success: boolean;
  /** The new login's access token — Philibert's record that it is logged in. */
  token?: string;
  error?: string;
}

/**
 * Resource handlers for cleanup during OAuth flow
 */
interface OAuthResourceHandlers {
  dataHandler: { dispose: () => void } | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  resolved: boolean;
  cleanup: () => void;
}

export class AuthService {
  private pendingOAuthFlow: OAuthFlowState | null = null;

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
   * How to run the Claude CLI with `args` on this install: the file to spawn,
   * its arguments, and the environment it needs on top of the app's. Spawned
   * directly, not through a shell (like mautrix-claude sidecar), except for
   * the npx fallback.
   */
  private cliCommand(cliArgs: readonly string[]): { file: string; args: string[]; extraEnv: Record<string, string> } {
    const claudeCli = this.findClaudeCli();
    const isNpx = claudeCli === 'npx';
    const isNativeBinary = ClaudeCliPaths.isNativeBinary(claudeCli);
    const isNodeScript = claudeCli.endsWith('.js') || claudeCli.endsWith('.cjs');

    let file: string;
    let args: string[];
    const extraEnv: Record<string, string> = {};

    if (isNpx) {
      // Fallback: use npx through shell (requires Node.js on system)
      file = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const npxCommand = ['npx @anthropic-ai/claude-code', ...cliArgs].join(' ');
      args = process.platform === 'win32' ? ['/c', npxCommand] : ['-c', npxCommand];
    } else if (isNativeBinary) {
      // v2.1.121+ native binary — spawn directly, no node.exe needed
      file = claudeCli;
      args = [...cliArgs];
      logger.info(`Using native Claude CLI binary: ${file}`);
    } else if (isNodeScript) {
      // Legacy cli.js or cli-wrapper.cjs — needs Node.js to execute
      if (process.platform === 'win32') {
        const bundledNodeExe = WindowsPaths.getBundledNodeExe();
        const nodeExeExists = WindowsPaths.hasBundledNode();
        logger.info('Windows: checking bundled Node.js for script execution', {
          bundledNodeExe, exists: nodeExeExists,
        });

        if (nodeExeExists) {
          file = bundledNodeExe;
          args = [claudeCli, ...cliArgs];
        } else {
          logger.warn('Windows: bundled Node.js not found, falling back to ELECTRON_RUN_AS_NODE');
          file = 'powershell.exe';
          const escapeForPowerShell = (s: string): string => s.replace(/'/g, "''");
          const escapedExePath = escapeForPowerShell(process.execPath);
          const escapedCliPath = escapeForPowerShell(claudeCli);
          const quotedArgs = cliArgs.map((arg) => `'${escapeForPowerShell(arg)}'`).join(' ');
          const psCommand = `$env:ELECTRON_RUN_AS_NODE='1'; & '${escapedExePath}' '${escapedCliPath}' ${quotedArgs}`;
          args = ['-NoProfile', '-Command', psCommand];
        }
      } else {
        file = process.execPath;
        args = [claudeCli, ...cliArgs];
        extraEnv.ELECTRON_RUN_AS_NODE = '1';
      }
      logger.info(`Using Node.js script CLI: ${file} ${JSON.stringify(args)}`);
    } else {
      // System CLI (e.g. /usr/local/bin/claude): spawn directly
      file = claudeCli;
      args = [...cliArgs];
    }

    // Find bundled Git Bash for Windows (Claude Code CLI requires it)
    const bundledGitBash = this.findBundledGitBash();
    if (process.platform === 'win32' && bundledGitBash) {
      logger.info('Setting CLAUDE_CODE_GIT_BASH_PATH for bundled Git Bash', { path: bundledGitBash });
      extraEnv.CLAUDE_CODE_GIT_BASH_PATH = bundledGitBash;
    } else if (process.platform === 'win32') {
      logger.warn('Windows: No bundled Git Bash found. Claude CLI may require Git Bash to be installed system-wide.');
    }

    logger.info('CLI spawn configuration', {
      spawnFile: file,
      spawnFileBuffer: Buffer.from(file).toString('hex'),
      spawnArgs: args,
      claudeCli,
      claudeCliBuffer: Buffer.from(claudeCli).toString('hex'),
      cliExists: fs.existsSync(claudeCli),
      spawnFileExists: fs.existsSync(file),
      extraEnv,
    });

    return { file, args, extraEnv };
  }

  /**
   * Log the CLI out (`claude auth logout`): the login is the CLI's own, so
   * logging out of Philibert logs out of it — the credentials and the
   * account it records. Resolves whether the CLI reported success.
   */
  async logoutCli(): Promise<boolean> {
    const { file, args, extraEnv } = this.cliCommand(LOGOUT_ARGS);
    return new Promise((resolve) => {
      execFile(file, args, { env: { ...process.env, ...extraEnv }, timeout: MAIN_CONSTANTS.AUTH.OAUTH_URL_DETECTION_TIMEOUT_MS }, (error, _stdout, stderr) => {
        if (error) {
          logger.warn('claude auth logout failed', { error: error.message, stderr: String(stderr).slice(0, 500) });
          resolve(false);
          return;
        }
        logger.info('Logged the Claude CLI out');
        resolve(true);
      });
    });
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

    // The login goes where the CLI keeps it: its own config directory, the
    // one sessions run with too (see cliCredentials.ts). What is there now is
    // the baseline — a login is a change from it, so an existing login (the
    // terminal's, or the one being replaced) is not mistaken for this one.
    const baselineCredentials = readCliCredentials();
    logger.info('Logging in to the CLI config directory', { configDir: cliConfigDir(), hasExistingLogin: baselineCredentials !== null });

    const { file: spawnFile, args: spawnArgs, extraEnv } = this.cliCommand(LOGIN_ARGS);

    // Environment without browser auto-open (like mautrix-claude sidecar).
    // CLAUDE_CONFIG_DIR is not set: the CLI picks its config directory as it
    // always does — including a CLAUDE_CONFIG_DIR the user set themselves.
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...extraEnv,
      // Prevent browser auto-open: use a command that does nothing
      // On Windows, 'echo' doesn't work as BROWSER - use empty string or cmd /c echo
      BROWSER: process.platform === 'win32' ? 'cmd /c echo' : '/bin/false',
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
              baselineCredentials,
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
    if (trimmed.length < 10 || trimmed.length > 500) return false;
    // The page shows `<code>#<state>`, and `auth login` reads it as one line
    // split on `#`. A line without both halves is not refused: the CLI says
    // so and goes on waiting, which would leave the login hanging here.
    const [authorizationCode, state, ...rest] = trimmed.split('#');
    return !!authorizationCode && !!state && rest.length === 0 && !/\s/.test(trimmed);
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

    const { pty: ptyProcess, baselineCredentials: baseline } = this.pendingOAuthFlow!;

    return new Promise((resolve) => {
      const handlers = this.createResourceHandlers();
      // What the CLI says after this code was sent: on a failure, its last
      // line is the reason, shown to the user as it is.
      let reply = '';

      try {
        // Listen for PTY output
        handlers.dataHandler = ptyProcess!.onData((data: string) => {
          reply += data;
          this.checkOAuthResult(baseline, handlers, resolve);
        });

        // Send code to PTY
        this.sendCodeToPty(ptyProcess!, code.trim());

        // Setup polling for result
        this.setupOAuthPolling(handlers, baseline, resolve);

        // Handle PTY exit
        this.setupPtyExitHandler(ptyProcess!, handlers, () => reply, baseline, resolve);
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
      return { success: false, error: 'Invalid authorization code format. Please copy the full code from the browser — it has two parts joined by #.' };
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

    // One line end, and only one. `auth login` reads stdin line by line, and
    // the terminal turns this CR into a line end; the LF that used to follow
    // it arrived as a second, empty line, which the CLI answers with "Invalid
    // code" — and that reply ended the login while the real code was still
    // being exchanged. Measured against the CLI (2.1.280): CR+LF prints the
    // invalid-code line at once, CR alone does not.
    setTimeout(() => {
      ptyProcess.write('\r');
    }, MAIN_CONSTANTS.AUTH.OAUTH_POLL_INTERVAL_MS / 10);
  }

  /**
   * Check whether the login has succeeded.
   *
   * The CLI's credentials file is the result: `auth login` writes it once the
   * code is accepted. Failure is the CLI exiting without having written it —
   * see setupPtyExitHandler. Words in its output are not taken as either: an
   * "invalid code" or "failed" anywhere in it used to end the login, which is
   * how a valid code was reported invalid.
   */
  private checkOAuthResult(
    baseline: string | null,
    handlers: OAuthResourceHandlers,
    resolve: (result: OAuthFlowResult) => void
  ): boolean {
    if (handlers.resolved) return true;

    const token = this.readNewLogin(baseline);
    if (token) {
      handlers.resolved = true;
      handlers.cleanup();
      logger.info('OAuth authentication successful via credentials file');
      this.cleanupOAuthFlow();
      resolve({ success: true, token });
      return true;
    }

    return false;
  }

  /**
   * The CLI's last line of output, as it wrote it — its reason, when it
   * exits without logging in ("Login failed: …"). Relayed, not interpreted.
   */
  private lastLine(output: string): string | null {
    const lines = stripAnsi(output).split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
    return lines.at(-1) ?? null;
  }

  /**
   * The access token of the login this flow wrote, once it has: the CLI's
   * credentials, changed from what they were when the flow started.
   */
  private readNewLogin(baseline: string | null): string | null {
    const credentialsJson = readCliCredentials();
    if (!credentialsJson || credentialsJson === baseline) return null;
    const token = accessTokenOf(credentialsJson);
    // Strict-validate even though the file is the CLI's own: storing a token
    // that will 401 is how users used to get logged out on every request.
    const validation = token ? validateOAuthTokenFormat(token) : { valid: false, error: 'no access token' };
    if (!token || !validation.valid) {
      logger.warn('Credentials file token failed format validation — ignoring', {
        reason: validation.error,
        tokenLength: token?.length ?? 0,
      });
      return null;
    }
    return token;
  }

  /**
   * Setup polling interval for OAuth result.
   */
  private setupOAuthPolling(
    handlers: OAuthResourceHandlers,
    baseline: string | null,
    resolve: (result: OAuthFlowResult) => void
  ): void {
    let attempts = 0;
    handlers.pollInterval = setInterval(() => {
      attempts++;
      if (this.checkOAuthResult(baseline, handlers, resolve)) {
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
   * Setup PTY exit handler: a last look for the credentials file, which the
   * CLI may write as it exits; without one, the login failed, for the reason
   * the CLI gave last. Cleanup either way.
   */
  private setupPtyExitHandler(
    ptyProcess: IPty,
    handlers: OAuthResourceHandlers,
    getReply: () => string,
    baseline: string | null,
    resolve: (result: OAuthFlowResult) => void
  ): void {
    ptyProcess.onExit(({ exitCode }) => {
      logger.info(`OAuth PTY exited with code ${exitCode}`);
      setTimeout(() => {
        if (!handlers.resolved) {
          this.checkOAuthResult(baseline, handlers, resolve);
          if (!handlers.resolved) {
            handlers.resolved = true;
            handlers.cleanup();
            const reason = this.lastLine(getReply());
            logger.warn('Login ended without credentials', { exitCode, reason });
            resolve({ success: false, error: reason ?? 'Authentication failed. Please try again.' });
          }
        }
        this.cleanupOAuthFlow();
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

    const { pty: ptyProcess } = this.pendingOAuthFlow;

    // Kill PTY process first
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (err) {
        logger.debug('PTY already terminated during cleanup', err);
      }
    }

    // Clear state immediately to prevent duplicate cleanup. Nothing on disk
    // to remove: the login runs in the CLI's own config directory.
    this.pendingOAuthFlow = null;

    logger.info('OAuth flow cleaned up');
  }

}

export default AuthService;
