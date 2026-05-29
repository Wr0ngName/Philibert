/**
 * Claude Code interactive session running in a pseudo-terminal (PTY).
 *
 * The PTY makes Claude Code detect an interactive terminal, which
 * triggers subscription billing instead of the SDK credit pool.
 * Communication with Claude Code happens via the MCP channel server
 * (a separate subprocess), not through the PTY.
 *
 * Usage tracking is provided by reading Claude Code's internal
 * session JSONL files (same approach as small-claw).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import type { ChannelUsageData, ChannelModelTokens } from '../../../shared/types';
import { MAIN_CONSTANTS } from '../../constants/app';
import { stripAnsi } from '../../utils/ansi';
import logger from '../../utils/logger';
import { getChannelSessionsDir, WindowsPaths } from '../../utils/resourcePaths';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.25, output: 1.25 },
  sonnet: { input: 3.00, output: 15.00 },
  opus: { input: 15.00, output: 75.00 },
};

function modelFamily(modelId: string): string {
  const name = modelId.toLowerCase();
  if (name.includes('opus')) return 'opus';
  if (name.includes('haiku')) return 'haiku';
  return 'sonnet';
}

function escapeCwdForClaude(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

function parseSessionUsage(jsonlPath: string): ChannelUsageData {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const models: Record<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.type !== 'assistant') continue;

    const message = entry.message;
    if (!message || typeof message !== 'object') continue;

    const msg = message as Record<string, unknown>;
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') continue;

    const u = usage as Record<string, unknown>;
    const modelId = typeof msg.model === 'string' ? msg.model : 'unknown';

    if (!models[modelId]) {
      models[modelId] = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
    }

    const acc = models[modelId];
    acc.input_tokens += Number(u.input_tokens) || 0;
    acc.output_tokens += Number(u.output_tokens) || 0;
    acc.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
    acc.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
  }

  const perModel: Record<string, ChannelModelTokens> = {};
  const totals: ChannelModelTokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };

  for (const [modelId, acc] of Object.entries(models)) {
    const pricing = MODEL_PRICING[modelFamily(modelId)] || MODEL_PRICING.sonnet;
    const inputCost = (acc.input_tokens / 1_000_000) * pricing.input;
    const cacheReadCost = (acc.cache_read_input_tokens / 1_000_000) * pricing.input * 0.1;
    const cacheCreationCost = (acc.cache_creation_input_tokens / 1_000_000) * pricing.input * 1.25;
    const outputCost = (acc.output_tokens / 1_000_000) * pricing.output;
    const modelCost = inputCost + cacheReadCost + cacheCreationCost + outputCost;

    perModel[modelId] = {
      inputTokens: acc.input_tokens,
      outputTokens: acc.output_tokens,
      cacheReadInputTokens: acc.cache_read_input_tokens,
      cacheCreationInputTokens: acc.cache_creation_input_tokens,
      costUsd: Math.round(modelCost * 1_000_000) / 1_000_000,
    };

    totals.inputTokens += acc.input_tokens;
    totals.outputTokens += acc.output_tokens;
    totals.cacheReadInputTokens += acc.cache_read_input_tokens;
    totals.cacheCreationInputTokens += acc.cache_creation_input_tokens;
    totals.costUsd += modelCost;
  }

  totals.costUsd = Math.round(totals.costUsd * 1_000_000) / 1_000_000;

  return { models: perModel, totals };
}

export type ChannelSessionErrorCallback = (conversationId: string, error: string) => void;
export type ChannelSessionPermissionCallback = (
  conversationId: string,
  requestId: string,
  toolName: string,
  description: string,
  inputPreview: string,
) => void;

export type ChannelSessionIdCallback = (conversationId: string, sessionId: string) => void;

export interface ChannelSessionOptions {
  conversationId: string;
  workingDirectory: string;
  claudeCliPath: string;
  bridgeUrl: string;
  bridgeToken: string;
  channelServerScript: string;
  model: string;
  authEnv: Record<string, string>;
  resumeSessionId?: string;
  onFatalError?: ChannelSessionErrorCallback;
  onPtyError?: ChannelSessionErrorCallback;
  onPermissionRequest?: ChannelSessionPermissionCallback;
  onSessionId?: ChannelSessionIdCallback;
}

export class ChannelSession {
  readonly conversationId: string;
  readonly workingDirectory: string;
  private claudeCliPath: string;
  private bridgeUrl: string;
  private bridgeToken: string;
  private channelServerScript: string;
  private model: string;
  private authEnv: Record<string, string>;
  private onFatalError?: ChannelSessionErrorCallback;
  private onPtyError?: ChannelSessionErrorCallback;
  private onPermissionRequest?: ChannelSessionPermissionCallback;
  private onSessionId?: ChannelSessionIdCallback;

  private ptyProcess: IPty | null = null;
  private running = false;
  private startupDialogsAccepted = 0;
  private fatalErrorEmitted = false;
  private cachedSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private pendingPtyPermissions: Set<string> = new Set();
  private emittedPtyErrors: Set<string> = new Set();
  private sessionIdTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ChannelSessionOptions) {
    this.conversationId = options.conversationId;
    this.workingDirectory = options.workingDirectory;
    this.claudeCliPath = options.claudeCliPath;
    this.bridgeUrl = options.bridgeUrl;
    this.bridgeToken = options.bridgeToken;
    this.channelServerScript = options.channelServerScript;
    this.model = options.model;
    this.authEnv = options.authEnv;
    this.resumeSessionId = options.resumeSessionId || null;
    this.onFatalError = options.onFatalError;
    this.onPtyError = options.onPtyError;
    this.onPermissionRequest = options.onPermissionRequest;
    this.onSessionId = options.onSessionId;
  }

  get isRunning(): boolean {
    return this.running && this.ptyProcess !== null;
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  private get sessionDir(): string {
    const dir = path.join(getChannelSessionsDir(), this.conversationId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Channel session already running', { conversationId: this.conversationId });
      return;
    }

    this.running = false;
    this.startupDialogsAccepted = 0;
    // Preserve previously discovered session ID for crash recovery restarts
    if (this.cachedSessionId && !this.resumeSessionId) {
      this.resumeSessionId = this.cachedSessionId;
    }
    this.cachedSessionId = null;
    this.emittedPtyErrors.clear();
    if (this.sessionIdTimer) {
      clearInterval(this.sessionIdTimer);
      this.sessionIdTimer = null;
    }

    this.setupMcpJson();
    this.setupClaudeSettings();

    const mcpJsonPath = path.join(this.sessionDir, '.mcp.json');

    const args = [
      '--dangerously-load-development-channels',
      'server:philibert',
      '--model',
      this.model,
      '--allowedTools',
      'mcp__philibert__reply',
      '--mcp-config',
      mcpJsonPath,
      '--verbose',
      '--debug',
    ];

    if (this.resumeSessionId) {
      args.push('--resume', this.resumeSessionId);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.authEnv,
      TERM: 'xterm-256color',
    };

    // Prevent Claude Code from auto-opening a browser
    if (process.platform !== 'win32') {
      env.BROWSER = '/bin/false';
    }

    const cwd = this.workingDirectory;

    logger.info('Starting Claude Code channel session in PTY', {
      conversationId: this.conversationId,
      cwd,
      claudeCli: this.claudeCliPath,
      model: this.model,
      resumeSessionId: this.resumeSessionId?.slice(0, 20) || null,
    });

    this.ptyProcess = pty.spawn(this.claudeCliPath, args, {
      name: 'xterm-256color',
      cols: MAIN_CONSTANTS.CHANNEL.PTY_COLS,
      rows: MAIN_CONSTANTS.CHANNEL.PTY_ROWS,
      cwd,
      env,
    });

    this.running = true;

    logger.info('Claude Code channel session started', {
      conversationId: this.conversationId,
      pid: this.ptyProcess.pid,
    });

    this.startSessionIdPolling();

    let buffer = '';

    const ptyLogPath = path.join(os.tmpdir(), `philibert-pty-${this.conversationId}.log`);
    const ptyLogStream = fs.createWriteStream(ptyLogPath, { flags: 'a' });
    logger.info('PTY output will be logged to', { path: ptyLogPath });

    this.ptyProcess.onData((data: string) => {
      ptyLogStream.write(data);
      buffer += data;
      const clean = stripAnsi(buffer);

      // Auto-accept startup dialogs (workspace trust, MCP server trust,
      // development channels warning, first-run theme picker).
      // All are menu selectors needing Enter.
      // Cap at 5 to prevent infinite loops on unexpected dialogs.
      const MAX_STARTUP_DIALOGS = 5;
      if (this.startupDialogsAccepted < MAX_STARTUP_DIALOGS) {
        const normalized = clean.replace(/\s+/g, '').toLowerCase();
        const isStartupDialog =
          // Workspace trust
          normalized.includes('trustthisfolder') ||
          normalized.includes('oneyoutrust') ||
          // MCP server trust
          (normalized.includes('mcpserver') && normalized.includes('philibert')) ||
          // Development channels warning
          normalized.includes('developmentchannels');

        // First-run dialogs without "enter to confirm" text — Enter
        // selects the currently highlighted menu option.
        const isFirstRunDialog =
          // Theme picker ("Choose the text style that looks best...")
          normalized.includes('choosethetextstyle') ||
          // Login method selector ("Select login method:")
          normalized.includes('selectloginmethod') ||
          // Post-login continuation ("Login successful. Press Enter to continue")
          normalized.includes('loginsuccessful');

        if ((isStartupDialog && normalized.includes('entertoconfirm')) || isFirstRunDialog) {
          setTimeout(() => {
            if (this.ptyProcess) {
              this.ptyProcess.write('\r');
              this.startupDialogsAccepted++;
              logger.info('Auto-accepted startup dialog', {
                conversationId: this.conversationId,
                count: this.startupDialogsAccepted,
              });
            }
          }, 300);
          buffer = '';
          return;
        }
      }

      // PTY permission dialog relay (fallback if MCP channel permission
      // protocol isn't used). Detects Claude Code's interactive tool approval
      // dialogs and surfaces them to the Philibert UI, or auto-accepts
      // philibert MCP tools that should already be pre-allowed.
      //
      // Tool section isolation: Claude Code uses ● (U+25CF) before tool call
      // names and ← (U+2190) before channel messages. To avoid false positives
      // from "philibert" appearing in channel message labels (←philibert:...),
      // we extract the text between the last ● and the dialog prompt and only
      // check THAT section for tool identity.
      {
        const normalized = clean.replace(/\s+/g, '').toLowerCase();
        const dialogPos = normalized.lastIndexOf('doyouwanttoproceed');
        if (dialogPos >= 0 && normalized.includes('yes', dialogPos)) {
          // Positional guard: dialog must be near the end of output
          if (normalized.length - dialogPos <= 500) {
            // Find the dialog position in clean text (with whitespace preserved)
            // for accurate tool name extraction
            const cleanLower = clean.toLowerCase();
            const dialogPosClean = cleanLower.lastIndexOf('do you want to proceed');
            const precedingClean = dialogPosClean >= 0 ? clean.slice(0, dialogPosClean) : clean;
            const lastToolMarker = precedingClean.lastIndexOf('●');
            const toolSection = lastToolMarker >= 0
              ? precedingClean.slice(lastToolMarker)
              : precedingClean.slice(-300);

            // Auto-accept philibert MCP tool dialogs (pre-allowed by settings)
            if (toolSection.toLowerCase().includes('philibert')) {
              setTimeout(() => {
                if (this.ptyProcess) {
                  this.ptyProcess.write('\r');
                  logger.info('Auto-accepted philibert MCP tool dialog', {
                    conversationId: this.conversationId,
                    toolSection: toolSection.slice(0, 200),
                  });
                }
              }, 300);
              buffer = '';
              return;
            }

            // Relay other tool permission dialogs to the UI
            if (this.onPermissionRequest) {
              const toolMatch = toolSection.match(/(\w+)\(([^)]*)\)/);
              if (toolMatch) {
                const requestId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const toolName = toolMatch[1];
                const toolArgs = toolMatch[2];
                this.pendingPtyPermissions.add(requestId);
                this.onPermissionRequest(
                  this.conversationId,
                  requestId,
                  toolName,
                  `${toolName}(${toolArgs})`,
                  toolArgs,
                );
                logger.info('Relayed PTY permission dialog to UI', {
                  conversationId: this.conversationId,
                  requestId,
                  toolName,
                  toolArgs: toolArgs.slice(0, 100),
                });
                buffer = '';
                return;
              }
            }
          }
        }
      }

      // Detect CLI errors that indicate channel mode isn't supported.
      // Uses recent data only (not accumulated buffer) to avoid false positives.
      if (!this.fatalErrorEmitted) {
        const recentLowerFatal = stripAnsi(data).toLowerCase();
        if (
          recentLowerFatal.includes('unknown option') ||
          recentLowerFatal.includes('unrecognized option') ||
          recentLowerFatal.includes('error: command not found')
        ) {
          this.fatalErrorEmitted = true;
          logger.error('Claude CLI does not support channel mode flags', {
            conversationId: this.conversationId,
            output: recentLowerFatal.slice(0, 500),
          });
          if (this.onFatalError) {
            this.onFatalError(
              this.conversationId,
              'Your Claude CLI version does not support channel mode. Please update Claude Code or switch to SDK mode in Settings.',
            );
          }
        }
      }

      // Detect recoverable PTY errors by matching the exact error messages
      // that Claude Code CLI renders (from src/services/api/errors.ts).
      // Two guards against false positives:
      //   1. Phrases are CLI-specific (not generic keywords like "401").
      //   2. The match must appear near the END of the data chunk (within
      //      the last 300 chars). Real CLI errors are the last thing
      //      rendered; conversation text mentioning errors would have
      //      more content following.
      if (this.onPtyError) {
        const recentLower = stripAnsi(data).toLowerCase();
        const MAX_TRAILING = 300;
        const errorPatterns: Array<{ phrases: string[]; message: string }> = [
          {
            phrases: ["you've hit your", "you're out of extra usage", 'request rejected (429)', 'extra usage is required'],
            message: 'Rate limited by API. Claude Code will retry automatically.',
          },
          {
            phrases: ['please run /login', 'oauth token revoked', 'does not have access to claude code', 'failed to authenticate', 'invalid api key', 'authentication error'],
            message: 'Authentication error. Please check your credentials in Settings.',
          },
          {
            phrases: ['credit balance is too low', 'belongs to a disabled organization'],
            message: 'Usage quota exceeded. Check your subscription status.',
          },
          {
            phrases: ['prompt is too long', 'request too large'],
            message: 'Context window exceeded. Start a new conversation to continue.',
          },
        ];

        for (const pattern of errorPatterns) {
          if (this.emittedPtyErrors.has(pattern.message)) continue;
          const matched = pattern.phrases.find((p) => recentLower.includes(p));
          if (!matched) continue;
          const pos = recentLower.lastIndexOf(matched);
          if (recentLower.length - pos > MAX_TRAILING) continue;

          this.emittedPtyErrors.add(pattern.message);
          logger.warn('Channel PTY error detected', {
            conversationId: this.conversationId,
            error: pattern.message,
            matchedPhrase: matched,
            output: recentLower.slice(Math.max(0, pos - 50), pos + matched.length + 100),
          });
          this.onPtyError(this.conversationId, pattern.message);
          break;
        }
      }

      // Log meaningful output lines
      for (const line of stripAnsi(data).split('\n')) {
        const stripped = line.trim();
        if (stripped && stripped.length > 3) {
          logger.debug('claude-pty', {
            conversationId: this.conversationId,
            line: stripped.slice(0, 200),
          });
        }
      }

      // Prevent buffer from growing unbounded
      if (buffer.length > 16384) {
        buffer = buffer.slice(-8192);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      if (this.sessionIdTimer) {
        clearInterval(this.sessionIdTimer);
        this.sessionIdTimer = null;
      }

      logger.info('Claude Code channel session exited', {
        conversationId: this.conversationId,
        exitCode,
        signal,
      });

      // On abnormal exit, check the tail of the buffer for CLI error
      // phrases. The match must be near the end (last 500 chars) since
      // CLI errors are the final output before exit.
      if (exitCode && exitCode !== 0 && this.onPtyError) {
        const tail = stripAnsi(buffer.slice(-2000)).toLowerCase();
        const MAX_TRAILING = 500;
        const exitErrors: Array<{ phrases: string[]; message: string }> = [
          {
            phrases: ['please run /login', 'oauth token revoked', 'does not have access to claude code', 'failed to authenticate', 'invalid api key'],
            message: 'Authentication error. Please check your credentials in Settings.',
          },
          {
            phrases: ['credit balance is too low', 'belongs to a disabled organization'],
            message: 'Usage quota exceeded. Check your subscription status.',
          },
        ];
        for (const pattern of exitErrors) {
          if (this.emittedPtyErrors.has(pattern.message)) continue;
          const matched = pattern.phrases.find((p) => tail.includes(p));
          if (!matched) continue;
          const pos = tail.lastIndexOf(matched);
          if (tail.length - pos > MAX_TRAILING) continue;

          this.emittedPtyErrors.add(pattern.message);
          logger.warn('Channel PTY error detected on exit', {
            conversationId: this.conversationId,
            exitCode,
            error: pattern.message,
            matchedPhrase: matched,
            output: tail.slice(Math.max(0, pos - 50)),
          });
          this.onPtyError(this.conversationId, pattern.message);
          break;
        }
      }

      this.ptyProcess = null;
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.sessionIdTimer) {
      clearInterval(this.sessionIdTimer);
      this.sessionIdTimer = null;
    }

    if (!this.ptyProcess) return;

    const pid = this.ptyProcess.pid;
    logger.info('Stopping Claude Code channel session', {
      conversationId: this.conversationId,
      pid,
    });

    try {
      this.ptyProcess.kill();
    } catch (err) {
      logger.warn('Failed to kill channel session PTY', {
        conversationId: this.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Wait briefly for exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 10000);

      if (this.ptyProcess) {
        this.ptyProcess.onExit(() => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.ptyProcess = null;
  }

  getUsage(): ChannelUsageData | null {
    try {
      const jsonlPath = this.findSessionJsonl();
      if (!jsonlPath) return null;
      return parseSessionUsage(jsonlPath);
    } catch (err) {
      logger.warn('Failed to read channel session usage', {
        conversationId: this.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  cleanupSessionDir(): void {
    try {
      const dir = path.join(getChannelSessionsDir(), this.conversationId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn('Failed to cleanup channel session directory', {
        conversationId: this.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  submitPtyPermission(requestId: string, behavior: 'allow' | 'deny'): boolean {
    if (!this.pendingPtyPermissions.has(requestId)) return false;
    this.pendingPtyPermissions.delete(requestId);

    if (!this.ptyProcess) return false;

    if (behavior === 'allow') {
      this.ptyProcess.write('\r');
    } else {
      // Navigate to "No" (last option) with down arrows, then Enter.
      // Extra down presses are harmless — terminal selectors stop at last option.
      this.ptyProcess.write('\x1B[B\x1B[B\x1B[B\x1B[B\x1B[B\r');
    }

    logger.info('Submitted PTY permission verdict', {
      conversationId: this.conversationId,
      requestId,
      behavior,
    });
    return true;
  }

  private setupClaudeSettings(): void {
    const claudeDir = path.join(this.sessionDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const localSettings = {
      enabledMcpjsonServers: ['philibert'],
      enableAllProjectMcpServers: true,
      permissions: {
        allow: ['mcp__philibert__reply'],
      },
    };

    fs.writeFileSync(settingsPath, JSON.stringify(localSettings, null, 2) + '\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(settingsPath, 0o600);
    }

    // Claude Code's getGlobalClaudeFile() resolves the config file as:
    //   1. If CLAUDE_CONFIG_DIR is set: join(CLAUDE_CONFIG_DIR, '.claude.json')
    //   2. Legacy: if ~/.claude/.config.json exists, use that
    //   3. Default: join(homedir(), '.claude.json')   ← NOT ~/.claude/.claude.json
    // Ref: src/utils/env.ts in https://github.com/codeaashu/claude-code
    const claudeConfigDir = this.authEnv.CLAUDE_CONFIG_DIR || CLAUDE_HOME;
    fs.mkdirSync(claudeConfigDir, { recursive: true });

    const legacyConfigPath = path.join(CLAUDE_HOME, '.config.json');
    let claudeJsonPath: string;
    if (this.authEnv.CLAUDE_CONFIG_DIR) {
      claudeJsonPath = path.join(this.authEnv.CLAUDE_CONFIG_DIR, '.claude.json');
    } else if (fs.existsSync(legacyConfigPath)) {
      claudeJsonPath = legacyConfigPath;
    } else {
      claudeJsonPath = path.join(os.homedir(), '.claude.json');
    }

    let claudeJson: Record<string, unknown> = {};
    try {
      if (fs.existsSync(claudeJsonPath)) {
        claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      }
    } catch {
      logger.warn('Could not parse Claude config, will overwrite', { path: claudeJsonPath });
    }

    if (!claudeJson.hasCompletedOnboarding) {
      claudeJson.hasCompletedOnboarding = true;
      claudeJson.theme = claudeJson.theme || 'dark';
      fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
      logger.info('Pre-wrote hasCompletedOnboarding to Claude config', { path: claudeJsonPath });
    }

    const globalSettingsPath = path.join(claudeConfigDir, 'settings.json');
    const projectKey = this.workingDirectory.replace(/\\/g, '/');

    let globalSettings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(globalSettingsPath)) {
        globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'));
      }
    } catch {
      logger.warn('Could not parse global Claude settings, will merge carefully');
    }

    const projects = (globalSettings.projects ?? {}) as Record<string, Record<string, unknown>>;
    projects[projectKey] = {
      ...(projects[projectKey] ?? {}),
      hasTrustDialogAccepted: true,
      allowedTools: ['mcp__philibert__reply'],
    };
    globalSettings.projects = projects;

    fs.writeFileSync(globalSettingsPath, JSON.stringify(globalSettings, null, 2) + '\n');

    logger.info('Pre-created Claude settings with tool permissions and workspace trust', {
      conversationId: this.conversationId,
      localSettings: settingsPath,
      projectKey,
    });
  }

  private setupMcpJson(): void {
    const mcpJsonPath = path.join(this.sessionDir, '.mcp.json');
    let nodeCmd = 'node';
    if (process.platform === 'win32') {
      const bundled = WindowsPaths.getBundledNodeExe();
      nodeCmd = fs.existsSync(bundled) ? bundled : 'node.exe';
    }

    const newConfig = {
      mcpServers: {
        philibert: {
          command: nodeCmd,
          args: [this.channelServerScript],
          env: {
            PHILIBERT_BRIDGE_URL: this.bridgeUrl,
            PHILIBERT_CONVERSATION_ID: this.conversationId,
            PHILIBERT_CHANNEL_TOKEN: this.bridgeToken,
          },
        },
      },
    };

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(mcpJsonPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      } catch {
        logger.warn('Could not parse existing .mcp.json, overwriting');
      }
    }

    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers as Record<string, unknown> || {}),
        ...newConfig.mcpServers,
      },
    };

    fs.writeFileSync(mcpJsonPath, JSON.stringify(merged, null, 2) + '\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(mcpJsonPath, 0o600);
    }

    logger.info('Updated .mcp.json with channel server config', {
      conversationId: this.conversationId,
      path: mcpJsonPath,
      channelServerScript: this.channelServerScript,
      bridgeUrl: this.bridgeUrl,
    });
  }

  private startSessionIdPolling(): void {
    let attempts = 0;
    const MAX_ATTEMPTS = 30;

    this.sessionIdTimer = setInterval(() => {
      attempts++;
      const sessionId = this.discoverSessionId();

      if (sessionId) {
        clearInterval(this.sessionIdTimer!);
        this.sessionIdTimer = null;
        this.resumeSessionId = sessionId;
        if (this.onSessionId) {
          this.onSessionId(this.conversationId, sessionId);
        }
        logger.info('Discovered channel session ID', {
          conversationId: this.conversationId,
          sessionId: sessionId.slice(0, 20) + '...',
        });
        return;
      }

      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(this.sessionIdTimer!);
        this.sessionIdTimer = null;
        logger.warn('Failed to discover channel session ID after polling', {
          conversationId: this.conversationId,
          attempts,
        });
      }
    }, 1000);
  }

  private discoverSessionId(): string | null {
    if (this.cachedSessionId) return this.cachedSessionId;
    if (!this.ptyProcess) return null;

    const pidFile = path.join(CLAUDE_HOME, 'sessions', `${this.ptyProcess.pid}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
      const sessionId = data.sessionId;
      if (typeof sessionId === 'string' && sessionId) {
        this.cachedSessionId = sessionId;
        return sessionId;
      }
    } catch {
      // File may not exist yet during startup
    }
    return null;
  }

  private findSessionJsonl(): string | null {
    const sessionId = this.discoverSessionId();
    if (!sessionId) return null;

    const escapedCwd = escapeCwdForClaude(this.sessionDir);
    const jsonlPath = path.join(CLAUDE_HOME, 'projects', escapedCwd, `${sessionId}.jsonl`);

    if (fs.existsSync(jsonlPath)) return jsonlPath;
    return null;
  }
}
