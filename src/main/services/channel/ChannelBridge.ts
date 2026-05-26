/**
 * Channel Bridge — HTTP IPC layer between the Electron main process
 * and the MCP channel server subprocess spawned by Claude Code.
 *
 * Provides per-conversation message queues, reply routing, and
 * permission request/verdict relay over a local HTTP server.
 */

import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';

import { MAIN_CONSTANTS } from '../../constants/app';
import logger from '../../utils/logger';

/** Callback invoked when Claude Code sends a reply via the channel server. */
export type ReplyCallback = (conversationId: string, text: string) => void;

/** Callback invoked when Claude Code requests tool permission. */
export type PermissionRequestCallback = (
  conversationId: string,
  request: PermissionRequestPayload,
) => void;

export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

interface PermissionVerdict {
  requestId: string;
  behavior: 'allow' | 'deny';
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  createdAt: number;
}

interface ConversationState {
  messageQueue: Array<{ content: string; meta: Record<string, string> }>;
  messageEmitter: EventEmitter;
  verdictQueue: PermissionVerdict[];
  verdictEmitter: EventEmitter;
  pendingPermissions: Map<string, PendingPermission>;
  mcpProbeRequested: boolean;
  mcpProbeResolvers: Array<(status: { permissionsForwarded: number }) => void>;
}

export class ChannelBridge {
  readonly token: string;
  private server: http.Server | null = null;
  private port = 0;
  private conversations: Map<string, ConversationState> = new Map();
  private onReply: ReplyCallback | null = null;
  private onPermissionRequest: PermissionRequestCallback | null = null;

  constructor() {
    this.token = crypto.randomBytes(32).toString('hex');
  }

  setReplyCallback(cb: ReplyCallback): void {
    this.onReply = cb;
  }

  setPermissionRequestCallback(cb: PermissionRequestCallback): void {
    this.onPermissionRequest = cb;
  }

  async start(): Promise<{ port: number }> {
    if (this.server) {
      return { port: this.port };
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      srv.on('error', (err) => {
        logger.error('ChannelBridge server error', { error: err.message });
        reject(err);
      });

      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr !== 'string') {
          this.port = addr.port;
        }
        this.server = srv;
        logger.info('ChannelBridge started', { port: this.port });
        resolve({ port: this.port });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.port = 0;
        this.conversations.clear();
        logger.info('ChannelBridge stopped');
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  getBridgeUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  pushMessage(conversationId: string, content: string): void {
    const state = this.ensureConversation(conversationId);
    const msg = {
      content,
      meta: {
        sender: 'user',
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    };

    if (state.messageQueue.length >= 1000) {
      state.messageQueue.shift();
      logger.warn('Channel message queue full, dropped oldest', { conversationId });
    }

    state.messageQueue.push(msg);
    state.messageEmitter.emit('message');
  }

  submitPermissionVerdict(
    conversationId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
  ): boolean {
    const state = this.conversations.get(conversationId);
    if (!state) return false;

    const pending = state.pendingPermissions.get(requestId);
    if (!pending) return false;

    state.pendingPermissions.delete(requestId);
    state.verdictQueue.push({ requestId, behavior });
    state.verdictEmitter.emit('verdict');
    return true;
  }

  hasPendingPermissionForTool(conversationId: string, toolName: string): boolean {
    const state = this.conversations.get(conversationId);
    if (!state) return false;
    for (const perm of state.pendingPermissions.values()) {
      if (perm.toolName === toolName) return true;
    }
    return false;
  }

  requestMcpProbe(conversationId: string): Promise<{ permissionsForwarded: number }> {
    const state = this.ensureConversation(conversationId);
    state.mcpProbeRequested = true;
    state.messageEmitter.emit('message');
    return new Promise((resolve) => {
      state.mcpProbeResolvers.push(resolve);
    });
  }

  removeConversation(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  private ensureConversation(conversationId: string): ConversationState {
    let state = this.conversations.get(conversationId);
    if (!state) {
      state = {
        messageQueue: [],
        messageEmitter: new EventEmitter(),
        verdictQueue: [],
        verdictEmitter: new EventEmitter(),
        pendingPermissions: new Map(),
        mcpProbeRequested: false,
        mcpProbeResolvers: [],
      };
      this.conversations.set(conversationId, state);
    }
    return state;
  }

  private validateToken(req: http.IncomingMessage): boolean {
    const authHeader = req.headers.authorization || '';
    const provided = authHeader.replace(/^Bearer\s+/i, '');
    if (provided.length !== this.token.length) return false;

    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    return crypto.timingSafeEqual(a, b);
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.validateToken(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    logger.debug('ChannelBridge request', { method, path: path.slice(0, 80) });

    if (method === 'GET' && path === '/api/channel/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const pollMatch = path.match(/^\/api\/channel\/poll\/(.+)$/);
    if (method === 'GET' && pollMatch) {
      const convId = decodeURIComponent(pollMatch[1]);
      const timeout = this.parseTimeout(url.searchParams.get('timeout'));
      this.handlePollMessages(convId, timeout, res);
      return;
    }

    const replyMatch = path.match(/^\/api\/channel\/reply\/(.+)$/);
    if (method === 'POST' && replyMatch) {
      const convId = decodeURIComponent(replyMatch[1]);
      this.readBody(req, (body) => {
        this.handleReply(convId, body, res);
      });
      return;
    }

    const permReqMatch = path.match(/^\/api\/channel\/permission\/request\/(.+)$/);
    if (method === 'POST' && permReqMatch) {
      const convId = decodeURIComponent(permReqMatch[1]);
      this.readBody(req, (body) => {
        this.handlePermissionRequest(convId, body, res);
      });
      return;
    }

    const mcpStatusMatch = path.match(/^\/api\/channel\/mcp-status\/(.+)$/);
    if (method === 'POST' && mcpStatusMatch) {
      const convId = decodeURIComponent(mcpStatusMatch[1]);
      this.readBody(req, (body) => {
        this.handleMcpStatusResponse(convId, body, res);
      });
      return;
    }

    const permPollMatch = path.match(/^\/api\/channel\/permission\/poll\/(.+)$/);
    if (method === 'GET' && permPollMatch) {
      const convId = decodeURIComponent(permPollMatch[1]);
      const timeout = this.parseTimeout(url.searchParams.get('timeout'));
      this.handlePollVerdicts(convId, timeout, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private parseTimeout(raw: string | null): number {
    const seconds = parseInt(raw || '30', 10);
    return Math.max(1, Math.min(60, isNaN(seconds) ? 30 : seconds)) * 1000;
  }

  private readBody(req: http.IncomingMessage, cb: (body: Record<string, unknown>) => void): void {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        cb(JSON.parse(data));
      } catch {
        cb({});
      }
    });
  }

  private handlePollMessages(
    conversationId: string,
    timeoutMs: number,
    res: http.ServerResponse,
  ): void {
    const state = this.ensureConversation(conversationId);

    const respond = () => {
      const messages = state.messageQueue.splice(0);
      const mcpProbe = state.mcpProbeRequested;
      if (mcpProbe) state.mcpProbeRequested = false;
      if (messages.length > 0) {
        logger.info('Bridge poll returning messages', {
          conversationId,
          count: messages.length,
          contentLengths: messages.map(m => m.content.length),
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages, ...(mcpProbe ? { mcpProbe: true } : {}) }));
    };

    if (state.messageQueue.length > 0 || state.mcpProbeRequested) {
      respond();
      return;
    }

    const timer = setTimeout(() => {
      state.messageEmitter.removeAllListeners('message');
      respond();
    }, timeoutMs);

    state.messageEmitter.once('message', () => {
      clearTimeout(timer);
      respond();
    });
  }

  private handleReply(
    conversationId: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing text field' }));
      return;
    }

    if (this.onReply) {
      this.onReply(conversationId, text);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private handlePermissionRequest(
    conversationId: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const state = this.ensureConversation(conversationId);

    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const toolName = typeof body.toolName === 'string' ? body.toolName : '';
    const description = typeof body.description === 'string' ? body.description : '';
    const inputPreview = typeof body.inputPreview === 'string' ? body.inputPreview : '';

    if (!requestId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing requestId' }));
      return;
    }

    this.expireStalePermissions(state);

    state.pendingPermissions.set(requestId, {
      requestId,
      toolName,
      createdAt: Date.now(),
    });

    if (this.onPermissionRequest) {
      this.onPermissionRequest(conversationId, {
        requestId,
        toolName,
        description,
        inputPreview,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private handlePollVerdicts(
    conversationId: string,
    timeoutMs: number,
    res: http.ServerResponse,
  ): void {
    const state = this.ensureConversation(conversationId);

    if (state.verdictQueue.length > 0) {
      const verdicts = state.verdictQueue.splice(0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdicts }));
      return;
    }

    const timer = setTimeout(() => {
      state.verdictEmitter.removeAllListeners('verdict');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdicts: [] }));
    }, timeoutMs);

    state.verdictEmitter.once('verdict', () => {
      clearTimeout(timer);
      const verdicts = state.verdictQueue.splice(0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdicts }));
    });
  }

  private handleMcpStatusResponse(
    conversationId: string,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const state = this.conversations.get(conversationId);
    const permissionsForwarded = typeof body.permissionsForwarded === 'number'
      ? body.permissionsForwarded : 0;

    logger.info('MCP status received from channel server', {
      conversationId,
      permissionsForwarded,
    });

    if (state && state.mcpProbeResolvers.length > 0) {
      for (const resolve of state.mcpProbeResolvers) {
        resolve({ permissionsForwarded });
      }
      state.mcpProbeResolvers = [];
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private expireStalePermissions(state: ConversationState): void {
    const now = Date.now();
    const ttl = MAIN_CONSTANTS.CHANNEL.PERMISSION_TTL_MS;

    for (const [id, perm] of state.pendingPermissions) {
      if (now - perm.createdAt > ttl) {
        state.pendingPermissions.delete(id);
        state.verdictQueue.push({ requestId: id, behavior: 'deny' });
        state.verdictEmitter.emit('verdict');
        logger.warn('Auto-denied stale permission request', {
          requestId: id,
          toolName: perm.toolName,
          ageMs: now - perm.createdAt,
        });
      }
    }
  }
}
