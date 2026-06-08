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

import type {
  AskUserQuestionAction,
  AskUserQuestionDetails,
  AskUserQuestionEntry,
  AskUserQuestionResponse,
  ChannelUsageData,
  PendingAction,
  SessionUsage,
} from '../../../shared/types';
import { IPC_CHANNELS } from '../../../shared/types';
import { MAIN_CONSTANTS } from '../../constants/app';
import logger from '../../utils/logger';
import { ClaudeCliPaths, ChannelPaths } from '../../utils/resourcePaths';
import type ConfigService from '../ConfigService';
import type NotificationService from '../NotificationService';
import { AuthValidator, ASK_USER_QUESTION_PREFIX } from '../claude';

import {
  ChannelBridge,
  type PermissionRequestPayload,
  type QuestionRequestPayload,
} from './ChannelBridge';
import { ChannelSession } from './ChannelSession';

const TURN_DONE_DELAY_MS = 2000;

interface ActiveChannelSession {
  session: ChannelSession;
  usageTimer: ReturnType<typeof setInterval> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  restartCount: number;
  turnDoneTimer: ReturnType<typeof setTimeout> | null;
}

interface McpSignal {
  promise: Promise<boolean>;
  resolve: (emitted: boolean) => void;
}

export class ChannelService {
  private bridge: ChannelBridge | null = null;
  private sessions: Map<string, ActiveChannelSession> = new Map();
  private send: (channel: string, ...args: unknown[]) => boolean;
  private configService: ConfigService;
  private notificationService: NotificationService;
  private authValidator: AuthValidator;
  private onTurnDone: ((conversationId: string) => void) | null = null;

  // Per-tool signal: MCP resolves it when done. PTY awaits it
  // to decide whether to emit as fallback.
  private mcpSignals = new Map<string, McpSignal>();

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

  setOnTurnDone(callback: (conversationId: string) => void): void {
    this.onTurnDone = callback;
  }

  private emitDone(conversationId: string): void {
    this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
    this.onTurnDone?.(conversationId);
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

    this.bridge.setPermissionFailedCallback((conversationId, toolName) => {
      this.handlePermissionFailed(conversationId, toolName);
    });

    this.bridge.setQuestionRequestCallback((conversationId, request) => {
      this.handleQuestionRequest(conversationId, request);
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
      this.emitDone(conversationId);
    }
  }

  /**
   * Deliver the user's answer to a pending AskUserQuestion back through the
   * bridge → channel-server. The channel-server side issues the deny verdict
   * and injects the `[User answered AskUserQuestion]:` user message.
   */
  handleQuestionAnswer(response: AskUserQuestionResponse): void {
    if (!this.bridge) {
      logger.warn('Cannot deliver question answer — bridge not running', {
        conversationId: response.conversationId,
        actionId: response.actionId,
      });
      return;
    }

    const followUpText = this.formatFollowUpMessage(response);

    const ok = this.bridge.submitQuestionAnswer(response.conversationId, {
      requestId: response.actionId,
      cancelled: response.cancelled,
      followUpText,
    });

    if (!ok) {
      logger.warn('Question answer not routed — no matching pending question', {
        conversationId: response.conversationId,
        actionId: response.actionId,
      });
    }
  }

  /**
   * Build the `[User answered AskUserQuestion]:` follow-up text from the
   * response — same shape produced in SDK mode so the model sees consistent
   * input regardless of execution mode.
   */
  private formatFollowUpMessage(response: AskUserQuestionResponse): string {
    if (response.cancelled || response.answers.length === 0) return '';

    const lines = response.answers.map((a) => {
      const note = a.notes ? ` (${a.notes})` : '';
      return `${a.question} ${a.answer}${note}`;
    });
    const body = lines.length === 1 ? lines[0] : lines.map((l) => `- ${l}`).join('\n');
    return `${ASK_USER_QUESTION_PREFIX} ${body}`;
  }

  handlePermissionResponse(
    conversationId: string,
    actionId: string,
    behavior: 'allow' | 'deny',
  ): void {
    this.mcpSignals.clear();

    // Try MCP bridge first (primary path)
    if (this.bridge && this.bridge.submitPermissionVerdict(conversationId, actionId, behavior)) {
      return;
    }

    // Fall back to PTY
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

  private getOrCreateMcpSignal(toolName: string): McpSignal {
    let signal = this.mcpSignals.get(toolName);
    if (!signal) {
      let resolve!: (emitted: boolean) => void;
      const promise = new Promise<boolean>((r) => { resolve = r; });
      signal = { promise, resolve };
      this.mcpSignals.set(toolName, signal);
    }
    return signal;
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
    const thinkingMode = await this.configService.getThinkingMode();
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
      thinkingMode,
      resumeSessionId,
      onSessionId: (convId, sessionId) => {
        this.send(IPC_CHANNELS.CLAUDE_SESSION_ID, convId, sessionId);
      },
      onFatalError: (convId, errorMsg) => {
        this.send(IPC_CHANNELS.CLAUDE_ERROR, convId, errorMsg);
        this.emitDone(convId);
        this.cleanupActiveSession(convId);
      },
      onPtyError: (convId, errorMsg) => {
        this.send(IPC_CHANNELS.CLAUDE_ERROR, convId, errorMsg);
        this.emitDone(convId);
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
      this.emitDone(conversationId);
      return;
    }

    if (active.turnDoneTimer) {
      clearTimeout(active.turnDoneTimer);
    }

    active.turnDoneTimer = setTimeout(() => {
      active.turnDoneTimer = null;
      this.emitDone(conversationId);
      this.notificationService.showQueryComplete(conversationId);
      this.pollUsage(conversationId);
    }, TURN_DONE_DELAY_MS);
  }

  private handleQuestionRequest(
    conversationId: string,
    request: QuestionRequestPayload,
  ): void {
    const questions: AskUserQuestionEntry[] = (request.questions || []).map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect,
      options: q.options.map((o) => ({
        label: o.label,
        description: o.description,
        ...(o.preview ? { preview: o.preview } : {}),
      })),
    }));

    const details: AskUserQuestionDetails = {
      questions,
      truncated: request.truncated,
      ...(request.truncated && request.description
        ? { fallbackDescription: request.description }
        : {}),
    };

    const description = questions.length > 0
      ? questions[0].question
      : (request.description || 'Claude is asking a question');

    const action: AskUserQuestionAction = {
      id: request.requestId,
      type: 'ask-user-question',
      toolName: 'AskUserQuestion',
      input: {},
      description,
      status: 'pending',
      timestamp: Date.now(),
      details,
    };

    logger.info('AskUserQuestion via channel', {
      conversationId,
      requestId: request.requestId,
      questionCount: questions.length,
      truncated: request.truncated,
    });

    this.send(IPC_CHANNELS.CLAUDE_TOOL_USE, conversationId, action);
  }

  private handlePermissionRequestFromBridge(
    conversationId: string,
    request: PermissionRequestPayload,
  ): void {
    const action = this.buildPermissionAction(
      request.requestId, request.toolName, request.description, request.inputPreview,
    );

    logger.info('Permission request via MCP', {
      conversationId,
      requestId: request.requestId,
      toolName: request.toolName,
    });

    this.send(IPC_CHANNELS.CLAUDE_TOOL_USE, conversationId, action);
    this.getOrCreateMcpSignal(request.toolName).resolve(true);
  }

  private handlePermissionFailed(conversationId: string, toolName: string): void {
    logger.warn('MCP permission forwarding failed — PTY fallback will handle', {
      conversationId, toolName,
    });
    this.getOrCreateMcpSignal(toolName).resolve(false);
  }

  private handlePermissionRequestFromPty(
    conversationId: string,
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
  ): void {
    const signal = this.getOrCreateMcpSignal(toolName);

    signal.promise.then((mcpEmitted) => {
      if (mcpEmitted) {
        logger.debug('PTY permission suppressed — MCP handled it', {
          conversationId, toolName, requestId,
        });
        return;
      }

      logger.info('Permission request via PTY fallback', {
        conversationId, toolName, requestId,
      });
      this.emitPtyPermission(conversationId, requestId, toolName, description, inputPreview);
    });
  }

  private emitPtyPermission(
    conversationId: string,
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
  ): void {
    const action = this.buildPermissionAction(requestId, toolName, description, inputPreview);
    this.send(IPC_CHANNELS.CLAUDE_TOOL_USE, conversationId, action);
  }

  private buildPermissionAction(
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
  ): PendingAction {
    const base = {
      id: requestId,
      toolName,
      description,
      input: { command: inputPreview },
      status: 'pending' as const,
      timestamp: Date.now(),
    };

    switch (toolName) {
      case 'Read':
      case 'Glob':
      case 'Grep':
        return { ...base, type: 'read-file', details: { filePath: inputPreview } };
      case 'Edit':
        return { ...base, type: 'file-edit', details: { filePath: inputPreview, originalContent: '', newContent: '', diff: '' } };
      case 'Write':
        return { ...base, type: 'file-create', details: { filePath: inputPreview, content: '' } };
      default:
        return { ...base, type: 'bash-command', details: { command: inputPreview, workingDirectory: '' } };
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
        this.emitDone(conversationId);
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

    this.mcpSignals.clear();

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
