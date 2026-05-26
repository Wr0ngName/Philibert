/**
 * Channel mode orchestrator — coordinates the bridge, PTY sessions,
 * and message flow for subscription-billed Claude Code execution.
 *
 * Produces the same IPC events as SDK mode (CLAUDE_CHUNK, CLAUDE_DONE,
 * CLAUDE_TOOL_USE, CLAUDE_USAGE_UPDATE) so the renderer needs minimal
 * changes.
 *
 * Turn boundary: Claude Code may call the reply tool multiple times per
 * turn. We accumulate replies and emit CLAUDE_DONE only after a quiet
 * period (no new replies for TURN_DONE_DELAY_MS), signaling the model
 * has finished its turn.
 */

import type { ChannelUsageData, PendingAction, SessionUsage } from '../../../shared/types';
import { IPC_CHANNELS } from '../../../shared/types';
import { MAIN_CONSTANTS } from '../../constants/app';
import logger from '../../utils/logger';
import { ClaudeCliPaths, ChannelPaths } from '../../utils/resourcePaths';
import type ConfigService from '../ConfigService';
import type NotificationService from '../NotificationService';
import { AuthValidator } from '../claude';

import { ChannelBridge, type PermissionRequestPayload } from './ChannelBridge';
import { ChannelSession } from './ChannelSession';

const TURN_DONE_DELAY_MS = 2000;

// Claude Code fires BOTH an MCP channel permission notification AND a terminal
// dialog simultaneously.  MCP is the protocol path; the PTY dialog is a
// fallback for users whose feature gates (KAIROS/tengu_harbor_permissions)
// are closed.  MCP arrives before the PTY dialog (stdio vs terminal render),
// so when PTY detects a dialog we simply check if MCP already handled it.
const PERMISSION_DEDUP_WINDOW_MS = 10000;

interface ActiveChannelSession {
  session: ChannelSession;
  usageTimer: ReturnType<typeof setInterval> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  restartCount: number;
  turnDoneTimer: ReturnType<typeof setTimeout> | null;
}

export class ChannelService {
  private bridge: ChannelBridge | null = null;
  private sessions: Map<string, ActiveChannelSession> = new Map();
  private send: (channel: string, ...args: unknown[]) => boolean;
  private configService: ConfigService;
  private notificationService: NotificationService;
  private authValidator: AuthValidator;

  // MCP permission dedup: tracks recent MCP permission requests so the PTY
  // fallback can detect duplicates.  Keyed by `${conversationId}:${toolName}`.
  private recentMcpPermissions: Map<string, number> = new Map();

  constructor(
    configService: ConfigService,
    send: (channel: string, ...args: unknown[]) => boolean,
    notificationService: NotificationService,
  ) {
    this.configService = configService;
    this.send = send;
    this.notificationService = notificationService;
    this.authValidator = new AuthValidator(configService);
  }

  async ensureBridge(): Promise<ChannelBridge> {
    if (this.bridge) return this.bridge;

    this.bridge = new ChannelBridge();

    this.bridge.setReplyCallback((conversationId, text) => {
      this.handleReply(conversationId, text);
    });

    this.bridge.setPermissionRequestCallback((conversationId, request) => {
      this.handlePermissionRequestFromBridge(conversationId, request);
    });

    await this.bridge.start();
    logger.info('ChannelService bridge started', { port: this.bridge.getPort() });
    return this.bridge;
  }

  async sendMessage(
    conversationId: string,
    message: string,
    workingDirectory: string,
    resumeSessionId?: string,
  ): Promise<void> {
    try {
      const bridge = await this.ensureBridge();

      let active = this.sessions.get(conversationId);
      if (!active || !active.session.isRunning) {
        if (active) {
          this.cleanupActiveSession(conversationId);
        }
        active = await this.createSession(conversationId, workingDirectory, bridge, resumeSessionId);
      }

      bridge.pushMessage(conversationId, message);

      this.emitChannelStatus(conversationId, true, true);

      logger.info('Pushed message to channel bridge', {
        conversationId,
        messageLength: message.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('ChannelService.sendMessage failed', { conversationId, error: msg });
      this.send(IPC_CHANNELS.CLAUDE_ERROR, conversationId, `Channel mode error: ${msg}`);
      this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
    }
  }

  handlePermissionResponse(
    conversationId: string,
    actionId: string,
    behavior: 'allow' | 'deny',
  ): void {
    // Try MCP bridge first (primary path)
    if (this.bridge && this.bridge.submitPermissionVerdict(conversationId, actionId, behavior)) {
      return;
    }

    // Fall back to PTY permission (for when MCP protocol is unavailable)
    const active = this.sessions.get(conversationId);
    if (active?.session.submitPtyPermission(actionId, behavior)) {
      return;
    }

    logger.warn('Permission verdict not routed — no matching request', {
      conversationId, actionId, behavior,
    });
  }

  async abort(conversationId: string): Promise<void> {
    const active = this.sessions.get(conversationId);
    if (active?.turnDoneTimer) {
      clearTimeout(active.turnDoneTimer);
      active.turnDoneTimer = null;
    }
    this.cleanupActiveSession(conversationId);
    if (this.bridge) {
      this.bridge.removeConversation(conversationId);
    }
  }

  async shutdown(): Promise<void> {
    for (const [conversationId, active] of this.sessions.entries()) {
      if (active.turnDoneTimer) {
        clearTimeout(active.turnDoneTimer);
        active.turnDoneTimer = null;
      }
      this.cleanupActiveSession(conversationId);
    }
    this.sessions.clear();

    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }

    logger.info('ChannelService shut down');
  }

  isConversationActive(conversationId: string): boolean {
    const active = this.sessions.get(conversationId);
    return !!active && active.session.isRunning;
  }

  private async createSession(
    conversationId: string,
    workingDirectory: string,
    bridge: ChannelBridge,
    resumeSessionId?: string,
  ): Promise<ActiveChannelSession> {
    const claudeCliPath = ClaudeCliPaths.findBundledCli();
    if (!claudeCliPath) {
      throw new Error(
        'Claude CLI not found. Channel mode requires the Claude CLI to be installed.',
      );
    }

    const channelServerScript = ChannelPaths.getChannelServerScript();
    if (!channelServerScript) {
      throw new Error(
        'Channel server script not found. Please rebuild with: npm run build:channel-server',
      );
    }

    const selectedModel = await this.configService.getSelectedModel();
    const authEnv = await this.authValidator.setupAuthEnv();

    const session = new ChannelSession({
      conversationId,
      workingDirectory,
      claudeCliPath,
      bridgeUrl: bridge.getBridgeUrl(),
      bridgeToken: bridge.token,
      channelServerScript,
      model: selectedModel || 'sonnet',
      authEnv,
      resumeSessionId,
      onSessionId: (convId, sessionId) => {
        this.send(IPC_CHANNELS.CLAUDE_SESSION_ID, convId, sessionId);
      },
      onFatalError: (convId, errorMsg) => {
        this.send(IPC_CHANNELS.CLAUDE_ERROR, convId, errorMsg);
        this.send(IPC_CHANNELS.CLAUDE_DONE, convId);
        this.cleanupActiveSession(convId);
      },
      onPtyError: (convId, errorMsg) => {
        this.send(IPC_CHANNELS.CLAUDE_ERROR, convId, errorMsg);
        this.send(IPC_CHANNELS.CLAUDE_DONE, convId);
      },
      onPermissionRequest: (convId, requestId, toolName, description, inputPreview) => {
        this.handlePermissionRequestFromPty(convId, requestId, toolName, description, inputPreview);
      },
    });

    await session.start();

    const active: ActiveChannelSession = {
      session,
      usageTimer: null,
      healthTimer: null,
      restartCount: 0,
      turnDoneTimer: null,
    };

    this.sessions.set(conversationId, active);

    active.usageTimer = setInterval(() => {
      this.pollUsage(conversationId);
    }, MAIN_CONSTANTS.CHANNEL.USAGE_POLL_INTERVAL_MS);

    active.healthTimer = setInterval(() => {
      this.checkHealth(conversationId);
    }, MAIN_CONSTANTS.CHANNEL.HEALTH_CHECK_INTERVAL_MS);

    logger.info('Channel session created', {
      conversationId,
      pid: session.pid,
      model: selectedModel || 'sonnet',
    });

    return active;
  }

  /**
   * Handle a reply from the channel server. Uses a debounce timer to
   * detect turn boundaries: each reply resets the timer. CLAUDE_DONE
   * fires only after TURN_DONE_DELAY_MS of silence, so multi-reply
   * turns don't trigger spurious "done" events.
   */
  private handleReply(conversationId: string, text: string): void {
    this.send(IPC_CHANNELS.CLAUDE_CHUNK, conversationId, text);

    const active = this.sessions.get(conversationId);
    if (!active) {
      this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
      return;
    }

    if (active.turnDoneTimer) {
      clearTimeout(active.turnDoneTimer);
    }

    active.turnDoneTimer = setTimeout(() => {
      active.turnDoneTimer = null;
      this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
      this.notificationService.showQueryComplete(conversationId);
      this.pollUsage(conversationId);
    }, TURN_DONE_DELAY_MS);
  }

  private handlePermissionRequestFromBridge(
    conversationId: string,
    request: PermissionRequestPayload,
  ): void {
    // Record for PTY dedup — PTY fallback checks this before emitting
    const dedupKey = `${conversationId}:${request.toolName}`;
    this.recentMcpPermissions.set(dedupKey, Date.now());
    this.pruneRecentMcpPermissions();

    const action: PendingAction = {
      type: 'bash-command',
      id: request.requestId,
      toolName: request.toolName,
      description: request.description,
      input: { command: request.inputPreview },
      status: 'pending',
      timestamp: Date.now(),
      details: {
        command: request.inputPreview,
        workingDirectory: '',
      },
    };

    logger.info('Permission request via MCP channel protocol', {
      conversationId,
      requestId: request.requestId,
      toolName: request.toolName,
    });

    this.send(IPC_CHANNELS.CLAUDE_TOOL_USE, conversationId, action);
  }

  /**
   * PTY permission fallback.  MCP arrives before the PTY dialog (stdio is
   * faster than terminal render + buffer pattern matching).  If MCP already
   * raised this permission, suppress the PTY duplicate.  If not, MCP is
   * unavailable (feature gates closed) and PTY is the only path.
   */
  private handlePermissionRequestFromPty(
    conversationId: string,
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
  ): void {
    const dedupKey = `${conversationId}:${toolName}`;
    const mcpTs = this.recentMcpPermissions.get(dedupKey);
    if (mcpTs && Date.now() - mcpTs < PERMISSION_DEDUP_WINDOW_MS) {
      logger.info('Suppressed PTY permission — MCP already active', {
        conversationId, toolName, requestId,
      });
      return;
    }

    logger.info('Emitting PTY permission as fallback (MCP not available)', {
      conversationId, toolName, requestId,
    });

    const base = {
      id: requestId,
      toolName,
      description,
      input: { command: inputPreview },
      status: 'pending' as const,
      timestamp: Date.now(),
    };

    let action: PendingAction;
    const toolLower = toolName.toLowerCase();

    if (toolLower === 'read') {
      action = { ...base, type: 'read-file', details: { filePath: inputPreview } };
    } else if (toolLower === 'edit') {
      action = { ...base, type: 'file-edit', details: { filePath: inputPreview, originalContent: '', newContent: '', diff: '' } };
    } else if (toolLower === 'write') {
      action = { ...base, type: 'file-create', details: { filePath: inputPreview, content: '' } };
    } else {
      action = { ...base, type: 'bash-command', details: { command: inputPreview, workingDirectory: '' } };
    }

    this.send(IPC_CHANNELS.CLAUDE_TOOL_USE, conversationId, action);
  }

  private pruneRecentMcpPermissions(): void {
    const now = Date.now();
    for (const [key, ts] of this.recentMcpPermissions) {
      if (now - ts > PERMISSION_DEDUP_WINDOW_MS * 3) {
        this.recentMcpPermissions.delete(key);
      }
    }
  }

  private pollUsage(conversationId: string): void {
    const active = this.sessions.get(conversationId);
    if (!active) return;

    const usage = active.session.getUsage();
    if (!usage) return;

    const sessionUsage = this.convertToSessionUsage(usage);
    this.send(IPC_CHANNELS.CLAUDE_USAGE_UPDATE, conversationId, sessionUsage);
  }

  private convertToSessionUsage(data: ChannelUsageData): SessionUsage {
    const modelUsage: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      webSearchRequests: number;
      costUSD: number;
      contextWindow: number;
      maxOutputTokens: number;
    }> = {};

    for (const [modelId, tokens] of Object.entries(data.models)) {
      modelUsage[modelId] = {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
        webSearchRequests: 0,
        costUSD: tokens.costUsd,
        contextWindow: 0,
        maxOutputTokens: 0,
      };
    }

    return {
      totalCostUSD: data.totals.costUsd,
      usage: {
        inputTokens: data.totals.inputTokens,
        outputTokens: data.totals.outputTokens,
        cacheReadInputTokens: data.totals.cacheReadInputTokens,
        cacheCreationInputTokens: data.totals.cacheCreationInputTokens,
      },
      modelUsage,
      numTurns: 0,
      durationMs: 0,
    };
  }

  private checkHealth(conversationId: string): void {
    const active = this.sessions.get(conversationId);
    if (!active) return;

    if (!active.session.isRunning) {
      if (active.restartCount >= MAIN_CONSTANTS.CHANNEL.MAX_RESTART_ATTEMPTS) {
        logger.error('Channel session exceeded max restarts', {
          conversationId,
          restartCount: active.restartCount,
        });
        this.cleanupActiveSession(conversationId);
        this.send(
          IPC_CHANNELS.CLAUDE_ERROR,
          conversationId,
          'Channel session crashed too many times. Please start a new conversation.',
        );
        this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
        return;
      }

      active.restartCount++;
      const delay = Math.min(
        MAIN_CONSTANTS.CHANNEL.RESTART_BASE_DELAY_MS *
          Math.pow(2, active.restartCount - 1),
        60000,
      );

      logger.warn('Channel session crashed, restarting', {
        conversationId,
        restartCount: active.restartCount,
        delayMs: delay,
      });

      setTimeout(async () => {
        try {
          await active.session.start();
          active.restartCount = 0;
          logger.info('Channel session restarted', {
            conversationId,
            pid: active.session.pid,
          });
        } catch (err) {
          logger.error('Channel session restart failed', {
            conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, delay);
    }
  }

  private cleanupActiveSession(conversationId: string): void {
    const active = this.sessions.get(conversationId);
    if (!active) return;

    if (active.usageTimer) {
      clearInterval(active.usageTimer);
      active.usageTimer = null;
    }

    if (active.healthTimer) {
      clearInterval(active.healthTimer);
      active.healthTimer = null;
    }

    if (active.turnDoneTimer) {
      clearTimeout(active.turnDoneTimer);
      active.turnDoneTimer = null;
    }

    active.session.stop().catch((err) => {
      logger.warn('Error stopping channel session', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    active.session.cleanupSessionDir();
    this.sessions.delete(conversationId);
  }

  private emitChannelStatus(
    conversationId: string,
    bridgeHealthy: boolean,
    sessionRunning: boolean,
  ): void {
    this.send(IPC_CHANNELS.CLAUDE_CHANNEL_STATUS, conversationId, {
      mode: 'channel' as const,
      bridgeHealthy,
      sessionRunning,
    });
  }
}
