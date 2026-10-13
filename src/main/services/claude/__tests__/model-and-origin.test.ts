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
  resultEndsOurTurn,
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
  ])('does not end the user turn for origin kind %s', (kind) => {
    expect(isHumanOriginatedResult({ origin: { kind } })).toBe(false);
  });

  // 'coordinator', 'peer' and 'channel' deliberately DO end the turn. They are
  // not background-agent completions, and suppressing on them risked leaving
  // the spinner running forever — see the unknown-origin block below.
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

/**
 * The primary turn-end signal: the CLI echoes the uuid of the send whose turn
 * this result ends. Origin classification below is now only the fallback for a
 * CLI that echoes nothing.
 *
 * The two payload shapes asserted here were recorded from a real session (CLI
 * 2.1.278) running one turn that launched one background task, rather than
 * invented: the turn's own result echoed the uuid that was sent and carried no
 * origin at all, and the background task's result echoed nothing and carried
 * origin {kind:'task-notification'}.
 */
describe('resultEndsOurTurn', () => {
  const OURS = '95b5f48b-8099-4cb3-ad24-0f6dccd2b5bb';

  it('accepts the result that echoes the uuid we sent', () => {
    // Recorded shape: no origin at all, but an exact echo.
    expect(resultEndsOurTurn({ user_message_uuid: OURS }, OURS)).toBe(true);
  });

  it('rejects a result that echoes a different send', () => {
    expect(resultEndsOurTurn({ user_message_uuid: 'some-other-send' }, OURS)).toBe(false);
  });

  it('accepts a coalesced turn that folded our send in with others', () => {
    // Several sends close together run as one turn, whose result lists them
    // all and names the LAST in user_message_uuid.
    expect(
      resultEndsOurTurn(
        { user_message_uuid: 'the-last-one', user_message_uuids: ['earlier', OURS, 'the-last-one'] },
        OURS,
      ),
    ).toBe(true);
  });

  it('rejects a background task s result, which echoes nothing', () => {
    // Recorded shape: no echo, origin task-notification. The echo being absent
    // while we are waiting on a turn is itself the answer — but the origin
    // fallback agrees here, so this holds either way.
    expect(
      resultEndsOurTurn({ origin: { kind: 'task-notification' } }, OURS),
    ).toBe(false);
  });

  it('falls back to origin when the CLI echoes no uuid at all', () => {
    // An older CLI sends neither field. There is nothing better to go on, so
    // behaviour is exactly what it was before the echo existed.
    expect(resultEndsOurTurn({}, OURS)).toBe(true);
    expect(resultEndsOurTurn({ origin: { kind: 'observer' } }, OURS)).toBe(false);
  });

  it('falls back to origin between turns, when we are waiting on nothing', () => {
    expect(resultEndsOurTurn({ user_message_uuid: 'someone-elses' }, null)).toBe(true);
    expect(resultEndsOurTurn({ origin: { kind: 'auto-continuation' } }, null)).toBe(false);
  });

  it('does not treat an undocumented origin as ours when the echo disagrees', () => {
    // `coordinator` and `unclassified` are members of the SDK's origin union
    // with no documentation, so no list of kinds can be right about them. With
    // an echo present and not ours, the kind no longer has to be guessed.
    for (const kind of ['coordinator', 'unclassified']) {
      expect(resultEndsOurTurn({ origin: { kind }, user_message_uuid: 'not-ours' }, OURS)).toBe(
        false,
      );
    }
  });
});

describe('isHumanOriginatedResult — the fallback, for a CLI that echoes no uuid', () => {
  // Regression: this was an allowlist of 'human', so any origin the SDK
  // reported that wasn't literally 'human' suppressed turn completion and
  // left the UI spinning with no turn running. The SDK notes origin is absent
  // on older CLIs and that unstamped messages are "unattributed", so unknown
  // values are expected rather than exceptional.
  it.each(['channel', 'peer', 'coordinator', 'something-new'])(
    'ends the user turn for non-background origin %s',
    (kind) => {
      expect(isHumanOriginatedResult({ origin: { kind } })).toBe(true);
    },
  );

  it.each(['task-notification', 'auto-continuation', 'observer', 'observer-activity'])(
    'still suppresses turn completion for background origin %s',
    (kind) => {
      expect(isHumanOriginatedResult({ origin: { kind } })).toBe(false);
    },
  );
});

describe('SDKMessageHandler — session idle backstop', () => {
  it('signals idle so a stranded busy state can be cleared', async () => {
    const cb = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
      onSessionIdle: vi.fn(),
    };
    const h = new SDKMessageHandler(cb);

    await h.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'idle',
    } as never);
    expect(cb.onSessionIdle).toHaveBeenCalledTimes(1);
  });

  it('does not signal idle while the session is running', async () => {
    const cb = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
      onSessionIdle: vi.fn(),
    };
    const h = new SDKMessageHandler(cb);

    await h.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
    } as never);
    await h.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'requires_action',
    } as never);
    expect(cb.onSessionIdle).not.toHaveBeenCalled();
  });
});

describe('SDKMessageHandler — synthetic model is not a model reading', () => {
  it('does not report <synthetic> as the running model', async () => {
    const cb = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
      onModelReported: vi.fn(),
    };
    const h = new SDKMessageHandler(cb);

    // What the CLI emits when quota is exhausted.
    await h.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'quota exceeded' }] },
    } as never);

    // The handler forwards it; ClaudeCodeService.reconcileReportedModel is what
    // discards sentinels (covered by isRealModelId). Assert the raw value so a
    // future change that starts filtering here is a deliberate one.
    expect(cb.onModelReported).toHaveBeenCalledWith('<synthetic>', 'main');
  });
});

describe('SDKMessageHandler — per-agent model and token attribution', () => {
  let cb: MessageHandlerCallbacks & { onSubagentActivity: ReturnType<typeof vi.fn> };
  let handler: SDKMessageHandler;

  beforeEach(() => {
    cb = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
      onSubagentActivity: vi.fn(),
    } as never;
    handler = new SDKMessageHandler(cb);
  });

  it('attributes a sub-agent frame to the tool_use that spawned it', async () => {
    await handler.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent1',
      message: {
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 900 },
      },
    } as never);

    expect(cb.onSubagentActivity).toHaveBeenCalledWith({
      parentToolUseId: 'toolu_agent1',
      model: 'claude-sonnet-4-5',
      // Cache reads count as input — they are billed and they are context.
      inputTokens: 1000,
      outputTokens: 25,
    });
  });

  it('does not attribute main-thread frames to any agent', async () => {
    await handler.handleMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { model: 'claude-opus-4-8', content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    } as never);

    expect(cb.onSubagentActivity).not.toHaveBeenCalled();
  });

  it('tolerates a sub-agent frame with no usage block', async () => {
    await handler.handleMessage({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent1',
      message: { model: 'claude-sonnet-4-5', content: [] },
    } as never);

    expect(cb.onSubagentActivity).toHaveBeenCalledWith({
      parentToolUseId: 'toolu_agent1',
      model: 'claude-sonnet-4-5',
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
