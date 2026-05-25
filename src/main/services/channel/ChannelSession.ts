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
  return cwd.replace(/[/_]/g, '-');
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

export interface ChannelSessionOptions {
  conversationId: string;
  workingDirectory: string;
  claudeCliPath: string;
  bridgeUrl: string;
  bridgeToken: string;
  channelServerScript: string;
  model: string;
  authEnv: Record<string, string>;
  onFatalError?: ChannelSessionErrorCallback;
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

  private ptyProcess: IPty | null = null;
  private running = false;
  private trustAccepted = false;
  private fatalErrorEmitted = false;
  private cachedSessionId: string | null = null;

  constructor(options: ChannelSessionOptions) {
    this.conversationId = options.conversationId;
    this.workingDirectory = options.workingDirectory;
    this.claudeCliPath = options.claudeCliPath;
    this.bridgeUrl = options.bridgeUrl;
    this.bridgeToken = options.bridgeToken;
    this.channelServerScript = options.channelServerScript;
    this.model = options.model;
    this.authEnv = options.authEnv;
    this.onFatalError = options.onFatalError;
  }

  get isRunning(): boolean {
    return this.running && this.ptyProcess !== null;
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  private get sessionDir(): string {
    const dir = path.join(this.workingDirectory, '.channel-sessions', this.conversationId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Channel session already running', { conversationId: this.conversationId });
      return;
    }

    this.running = false;
    this.trustAccepted = false;
    this.cachedSessionId = null;

    this.setupMcpJson();

    const args = [
      '--dangerously-load-development-channels',
      'server:philibert',
      '--model',
      this.model,
      '--verbose',
    ];

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.authEnv,
      TERM: 'xterm-256color',
    };

    // Prevent Claude Code from auto-opening a browser
    if (process.platform !== 'win32') {
      env.BROWSER = '/bin/false';
    }

    const cwd = this.sessionDir;

    logger.info('Starting Claude Code channel session in PTY', {
      conversationId: this.conversationId,
      cwd,
      claudeCli: this.claudeCliPath,
      model: this.model,
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

    let buffer = '';

    this.ptyProcess.onData((data: string) => {
      buffer += data;
      const clean = stripAnsi(buffer);

      if (!this.trustAccepted && clean.toLowerCase().includes('trust')) {
        if (
          clean.toLowerCase().includes('do you trust') ||
          clean.toLowerCase().includes('trust this')
        ) {
          setTimeout(() => {
            if (this.ptyProcess) {
              this.ptyProcess.write('y\r\n');
              this.trustAccepted = true;
              logger.info('Auto-accepted trust dialog', {
                conversationId: this.conversationId,
              });
            }
          }, 300);
          buffer = '';
          return;
        }
      }

      // Detect CLI errors that indicate channel mode isn't supported
      if (!this.fatalErrorEmitted) {
        const lower = clean.toLowerCase();
        if (
          lower.includes('unknown option') ||
          lower.includes('unrecognized option') ||
          lower.includes('error: command not found')
        ) {
          this.fatalErrorEmitted = true;
          logger.error('Claude CLI does not support channel mode flags', {
            conversationId: this.conversationId,
            output: clean.slice(0, 500),
          });
          if (this.onFatalError) {
            this.onFatalError(
              this.conversationId,
              'Your Claude CLI version does not support channel mode. Please update Claude Code or switch to SDK mode in Settings.',
            );
          }
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
      logger.info('Claude Code channel session exited', {
        conversationId: this.conversationId,
        exitCode,
        signal,
      });
      this.ptyProcess = null;
    });
  }

  async stop(): Promise<void> {
    this.running = false;

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
      const dir = path.join(this.workingDirectory, '.channel-sessions', this.conversationId);
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

  private setupMcpJson(): void {
    const mcpJsonPath = path.join(this.sessionDir, '.mcp.json');
    const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';

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
    });
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
