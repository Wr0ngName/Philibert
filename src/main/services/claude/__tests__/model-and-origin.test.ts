/**
 * Tests for the separation of background-agent activity from the main
 * conversation, and for surfacing the model the CLI actually runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger to avoid Electron app dependency
vi.mock('../../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  SDKMessageHandler,
  isHumanOriginatedResult,
  type MessageHandlerCallbacks,
} from '../SDKMessageHandler';

describe('isHumanOriginatedResult', () => {
  it('treats a human-origin result as the end of the user turn', () => {
    expect(isHumanOriginatedResult({ origin: { kind: 'human' } })).toBe(true);
  });

  it('treats a missing origin as human so older CLIs keep working', () => {
    expect(isHumanOriginatedResult({})).toBe(true);
    expect(isHumanOriginatedResult({ origin: undefined })).toBe(true);
    expect(isHumanOriginatedResult({ origin: {} })).toBe(true);
  });

  // These are the origins that were ending the main turn: a finished
  // background agent being delivered back into the session would drop the
  // spinner and fire a "Query Complete" notification for work the user never
  // started.
  it.each([
    'task-notification',
    'auto-continuation',
    'observer',
    'observer-activity',
    'coordinator',
    'peer',
    'channel',
  ])('does not end the user turn for origin kind %s', (kind) => {
    expect(isHumanOriginatedResult({ origin: { kind } })).toBe(false);
  });
});

describe('SDKMessageHandler — sub-agent isolation', () => {
  let callbacks: MessageHandlerCallbacks;
  let handler: SDKMessageHandler;

  beforeEach(() => {
    callbacks = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
      onModelReported: vi.fn(),
      onModelSubstituted: vi.fn(),
    };
    handler = new SDKMessageHandler(callbacks);
  });

  it('streams main-thread text deltas into the conversation', async () => {
    await handler.handleMessage({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    } as never);

    expect(callbacks.onChunk).toHaveBeenCalledWith('hello');
  });

  it('does not stream sub-agent text deltas into the main conversation', async () => {
    await handler.handleMessage({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_abc123',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'agent chatter' } },
    } as never);

    expect(callbacks.onChunk).not.toHaveBeenCalled();
  });

  it('reports the main-thread model from an assistant frame', async () => {
    await handler.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { model: 'claude-opus-5', content: [] },
    } as never);

    expect(callbacks.onModelReported).toHaveBeenCalledWith('claude-opus-5', 'main');
  });

  it('tags a sub-agent frame as a sub-agent model reading', async () => {
    await handler.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'toolu_abc123',
      message: { model: 'claude-fable-5', content: [] },
    } as never);

    expect(callbacks.onModelReported).toHaveBeenCalledWith('claude-fable-5', 'subagent');
  });

  it('reports the resolved model from the init message', async () => {
    await handler.handleMessage({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 'sess_1',
    } as never);

    expect(callbacks.onModelReported).toHaveBeenCalledWith('claude-opus-5', 'init');
  });
});

describe('SDKMessageHandler — model substitution notices', () => {
  let callbacks: MessageHandlerCallbacks;
  let handler: SDKMessageHandler;

  beforeEach(() => {
    callbacks = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
      onModelReported: vi.fn(),
      onModelSubstituted: vi.fn(),
    };
    handler = new SDKMessageHandler(callbacks);
  });

  // With no dialog host the CLI swaps models without asking and makes the swap
  // persistent for the session; this notice is the only signal it happened.
  it('surfaces a refusal fallback swap', async () => {
    await handler.handleMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-fable-5',
      fallback_model: 'claude-opus-5',
      api_refusal_category: 'cyber',
      api_refusal_explanation: 'flagged',
    } as never);

    expect(callbacks.onModelSubstituted).toHaveBeenCalledWith({
      originalModel: 'claude-fable-5',
      fallbackModel: 'claude-opus-5',
      category: 'cyber',
      explanation: 'flagged',
    });
  });

  it('surfaces a refusal with no fallback and leaves the model unchanged', async () => {
    await handler.handleMessage({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      original_model: 'claude-opus-5',
      api_refusal_category: 'bio',
    } as never);

    expect(callbacks.onModelSubstituted).toHaveBeenCalledWith({
      originalModel: 'claude-opus-5',
      fallbackModel: null,
      category: 'bio',
      explanation: undefined,
    });
  });
});
